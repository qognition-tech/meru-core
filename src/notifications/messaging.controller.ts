import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from '../common/types';
import { SequenceRunnerService } from './sequence-runner.service';
import { NotificationsService } from './notifications.service';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant } from '../iam/entities/tenant.entity';

/**
 * The HTTP surface over pack-driven outbound messaging.
 *
 * `SequenceRunnerService` has run chasers, reminders and nurture sequences
 * from `messaging.sequences[]` since it shipped — and nothing could list,
 * preview, enrol or audit any of it, so newsletters and review requests were
 * pack authoring that no UI could see. Everything here is a read or an
 * explicit per-record action; the sweep itself stays on `/jobs`.
 *
 * Scope: firm-side roles. A `client` token never reaches this controller —
 * the sequences describe what the firm sends to clients.
 */
@ApiTags('messaging')
@ApiBearerAuth('JWT-auth')
@Controller('messaging')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@Roles(
  PlatformRole.PLATFORM_ADMIN,
  PlatformRole.FIRM_ADMIN,
  PlatformRole.STAFF,
)
export class MessagingController {
  constructor(
    private readonly sequences: SequenceRunnerService,
    private readonly notifications: NotificationsService,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  @Get('sequences')
  @ApiOperation({
    summary: "This tenant's messaging sequences, from the pack, with enrolment counts",
    description:
      'Definitions come from `messaging.sequences[]` of the resolved vertical pack; counts are live. An empty `sequences` means the pack authored none — not that messaging is off.',
  })
  @ApiResponse({ status: 200, description: 'Sequences listed' })
  async listSequences(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
  ) {
    const vertical = req.tenantVertical ?? null;
    const [definitions, counts] = await Promise.all([
      this.sequences.definitions(vertical),
      this.sequences.counts(req.user.tenantId),
    ]);
    return {
      vertical,
      sequences: definitions.map((d) => ({
        ...d,
        enrolments: counts[d.key] ?? { active: 0, stopped: 0 },
      })),
    };
  }

  @Get('sequences/:key/enrolments')
  @ApiOperation({ summary: 'Enrolments in one sequence' })
  @ApiParam({ name: 'key', description: 'messaging.sequences[].key' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'stopped', 'all'],
    description: 'Default all',
  })
  @ApiResponse({ status: 200, description: 'Enrolments listed' })
  @ApiResponse({ status: 404, description: 'No such sequence in the pack' })
  async listEnrolments(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Param('key') key: string,
    @Query('status') status?: 'active' | 'stopped' | 'all',
  ) {
    await this.requireSequence(req.tenantVertical ?? null, key);
    const rows = await this.sequences.enrolments(
      req.user.tenantId,
      key,
      status ?? 'all',
    );
    return { sequenceKey: key, enrolments: rows };
  }

  @Post('sequences/:key/enrolments/:entityId')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enrol a record in a sequence now',
    description:
      "Idempotent on an active enrolment (`created: false`). A stopped enrolment is re-opened from step 0. The first step goes out on the next `scope=fast` tick, not on this call — sending is the job's work, and this deployment's fast tick is daily until an external scheduler is pointed at it (CLAUDE.md §10).",
  })
  @ApiResponse({ status: 200, description: '`{enrolment, created}`' })
  @ApiResponse({ status: 400, description: 'Record type does not match the sequence trigger' })
  @ApiResponse({ status: 404, description: 'No such sequence or record' })
  async enrol(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Param('key') key: string,
    @Param('entityId') entityId: string,
  ) {
    return this.sequences.enrol(
      req.user.tenantId,
      req.tenantVertical ?? null,
      key,
      entityId,
    );
  }

  @Post('sequences/:key/enrolments/:entityId/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop an enrolment',
    description: 'Sets `stopReason: manual`. No-op on one already stopped — its original reason is kept.',
  })
  @ApiResponse({ status: 200, description: 'Enrolment, stopped' })
  @ApiResponse({ status: 404, description: 'Not enrolled' })
  async stop(
    @Request() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Param('entityId') entityId: string,
  ) {
    return this.sequences.stop(req.user.tenantId, key, entityId);
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Message templates — tenant overrides and pack defaults, with `source`',
  })
  @ApiQuery({ name: 'channel', required: false, description: 'email | sms | push | in_app' })
  @ApiResponse({ status: 200, description: 'Templates listed' })
  async listTemplates(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Query('channel') channel?: string,
  ) {
    return this.notifications.getTemplates(
      req.user.tenantId,
      channel,
      req.tenantVertical ?? null,
    );
  }

  @Post('templates/:key/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Render a template without sending it',
    description:
      'With `entityId`, renders against that record using exactly the variables a sequence step supplies. `unrendered` lists placeholders still present — a template declaring a variable the runner cannot provide, which a recipient would otherwise see literally.',
  })
  @ApiResponse({
    status: 200,
    description: '`{templateKey, source, channel, subject, content, unrendered, variables}`',
  })
  @ApiResponse({ status: 404, description: 'No such template or record' })
  async preview(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Param('key') key: string,
    @Body() dto: PreviewTemplateDto,
  ) {
    const tenantId = req.user.tenantId;
    let variables: Record<string, unknown> = {};
    if (dto.entityId) {
      const [entity, tenant] = await Promise.all([
        this.entityRepo.findOne({ where: { id: dto.entityId, tenantId } }),
        this.tenantRepo.findOne({ where: { id: tenantId } }),
      ]);
      if (!entity) throw new NotFoundException(`Entity ${dto.entityId} not found`);
      variables = SequenceRunnerService.variablesFor(
        tenant ?? { name: '' },
        entity,
      );
    }
    variables = { ...variables, ...(dto.variables ?? {}) };

    const rendered = await this.notifications.renderTemplate(
      tenantId,
      key,
      variables,
      req.tenantVertical ?? null,
    );
    return {
      templateKey: key,
      source: rendered.resolved.source,
      channel: rendered.resolved.channel,
      subject: rendered.subject,
      content: rendered.content,
      unrendered: rendered.unrendered,
      variables,
    };
  }

  private async requireSequence(vertical: string | null, key: string) {
    const found = (await this.sequences.definitions(vertical)).find(
      (d) => d.key === key,
    );
    if (!found) {
      throw new NotFoundException(
        `No sequence '${key}' in the pack for vertical '${vertical ?? 'none'}'`,
      );
    }
    return found;
  }
}
