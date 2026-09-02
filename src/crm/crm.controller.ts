import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Patch,
  Put,
  Param,
  Query,
  Delete,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { Request as ExpressRequest } from 'express';
import { CrmService } from './crm.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import {
  ConvertEntityDto,
  ListEntitiesQueryDto,
  UpdateEntityDto,
} from './dto/update-entity.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { UserPayload, type AuthenticatedRequest } from '../common/types';
import { EntityRelationService } from './entity-relation.service';
import { CommentService } from './comment.service';
import { AcceptanceService } from './acceptance.service';
import { PackRuleService } from '../rules/pack-rule.service';
import { RecordAcceptanceDto } from './dto/record-acceptance.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { LinkEntitiesDto } from './dto/link-entities.dto';
import { paginated } from '../common/paginated';
import type { Response } from 'express';
import { Actor } from '../common/access';

@Controller('crm')
@ApiTags('crm')
export class CrmController {
  constructor(
    private crmService: CrmService,
    private relations: EntityRelationService,
    private readonly comments: CommentService,
    private readonly acceptance: AcceptanceService,
    private readonly packRules: PackRuleService,
  ) {}

  /**
   * A `client` is an applicant, not staff: they may see only records assigned to
   * them. RLS isolates one tenant from another, it does NOT isolate users inside
   * a tenant — so without this a client token received every case in the firm.
   * ImmiStack filtered in the browser, which is presentation, not authorisation.
   *
   * Forced rather than defaulted: a client cannot widen it by passing
   * `?assignedTo=` for somebody else. Shared by the list and the export, so an
   * export can never be broader than the list it mirrors.
   */
  private clientScoped(
    user: UserPayload,
    query: ListEntitiesQueryDto,
  ): ListEntitiesQueryDto {
    const roles = user.roles ?? [];
    const isStaff = roles.some((r) =>
      [
        PlatformRole.PLATFORM_ADMIN,
        PlatformRole.FIRM_ADMIN,
        PlatformRole.STAFF,
      ].includes(r as PlatformRole),
    );
    return roles.includes(PlatformRole.CLIENT) && !isStaff
      ? { ...query, assignedTo: user.id }
      : query;
  }

  /**
   * `Actor` is deliberately not `UserPayload` — see its own doc comment.
   * Every by-id route builds one from `req.user` and passes it down so
   * `CrmAccessService` can decide, in the service, whether this caller may
   * reach this particular record.
   */
  private actorFrom(user: UserPayload): Actor {
    return { id: user.id, roles: user.roles ?? [] };
  }

  // ==================== COMMENTS ====================
  //
  // Any record, not just tasks. Document annotations, case file notes and
  // breach investigation notes are one feature wearing three names.

  @Post('entities/:id/comments')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Comment on a record' })
  @ApiResponse({ status: 201, description: 'Comment added' })
  @ApiResponse({
    status: 400,
    description: 'Empty body, or no such record here',
  })
  addComment(
    @Request() req: ExpressRequest,
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
  ) {
    const user = req.user as UserPayload;
    return this.comments.add(
      user.tenantId,
      'record',
      id,
      {
        body: dto.body,
        authorId: user.id,
        internal: dto.internal,
      },
      this.actorFrom(user),
    );
  }

  @Get('entities/:id/comments')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Comments on a record, oldest first',
    description:
      'Internal notes are withheld unless `includeInternal=true` is asked for ' +
      'explicitly — the client portal reads this route too, and a default ' +
      'that leaks is a default that will leak.',
  })
  @ApiQuery({ name: 'includeInternal', required: false, type: Boolean })
  listComments(
    @Request() req: ExpressRequest,
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
  ) {
    const user = req.user as UserPayload;
    return this.comments.list(user.tenantId, id, this.actorFrom(user), {
      includeInternal: includeInternal === 'true',
    });
  }

  @Delete('entities/comments/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Remove a comment',
    description: 'Soft delete — a file note is part of the record.',
  })
  removeComment(@Request() req: ExpressRequest, @Param('id') id: string) {
    const user = req.user as UserPayload;
    return this.comments.remove(user.tenantId, id, this.actorFrom(user));
  }

  @Post('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a new CRM entity' })
  @ApiBody({ type: CreateEntityDto })
  @ApiResponse({ status: 201, description: 'Entity created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  createEntity(@Request() req: ExpressRequest, @Body() dto: CreateEntityDto) {
    // req.user comes from JWT (has tenantId and vertical)
    const user = req.user as UserPayload;
    return this.crmService.createEntity(user.tenantId, dto);
  }

  @Get('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List CRM entities for the tenant',
    description:
      'Filterable by type, status, assignee and due-date window. This one ' +
      'endpoint backs the obligation and breach registers and the case ' +
      'kanban — they are all records with a state, an owner and a deadline, ' +
      'distinguished only by `type`. Vertical labels come from the config pack.',
  })
  @ApiResponse({ status: 200, description: 'Entities retrieved successfully' })
  @ApiResponse({ status: 400, description: 'Unknown or malformed filter' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getEntities(
    @Request() req: ExpressRequest,
    @Query() query: ListEntitiesQueryDto,
  ) {
    const user = req.user as UserPayload;
    const scoped = this.clientScoped(user, query);

    const { items, total, page, limit } = await this.crmService.listEntities(
      user.tenantId,
      scoped,
    );
    return paginated(items, total, page, limit);
  }

  @Get('entities/export')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Export records as CSV',
    description:
      'Same filters as `GET /crm/entities`, returned as `text/csv`. The ' +
      'frontend was exporting client-side from whatever rows happened to be ' +
      'loaded, so an export of a filtered list silently gave you page one.\n\n' +
      'Capped at 10,000 rows. `X-Export-Truncated: true` says the cap was hit ' +
      'and the file is a prefix, not the whole set — a truncated export that ' +
      'does not say so is the same class of lie as a truncated count.\n\n' +
      'A `client`-role caller exports only their own records, exactly as on the ' +
      'list route.',
  })
  @ApiResponse({ status: 200, description: 'CSV document' })
  async exportEntities(
    @Request() req: ExpressRequest,
    @Res() res: Response,
    @Query() query: ListEntitiesQueryDto,
  ) {
    const user = req.user as UserPayload;
    const scoped = this.clientScoped(user, query);

    const { csv, truncated, rows } = await this.crmService.exportEntitiesCsv(
      user.tenantId,
      scoped,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="records-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader('X-Export-Rows', String(rows));
    if (truncated) res.setHeader('X-Export-Truncated', 'true');
    res.send(csv);
  }

  @Get('entities/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get a single CRM entity' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Entity retrieved' })
  @ApiResponse({ status: 404, description: 'No such entity on this tenant' })
  async getEntity(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user as UserPayload;
    return this.crmService.getEntity(id, user.tenantId, this.actorFrom(user));
  }

  @Patch('entities/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Update a CRM entity (partial)',
    description:
      'The write half of the registers and the kanban: status transitions, ' +
      'reassignment, due-date changes.\n\n`verticalAttributes` is **deep**-merged: ' +
      'send only the branch that changed and nested siblings survive. Send ' +
      '`null` for a key to remove it. Tenant is immutable here; to change ' +
      '`type` use `POST /crm/entities/:id/convert`, which keeps the id.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Entity updated' })
  @ApiResponse({ status: 404, description: 'No such entity on this tenant' })
  async updateEntity(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntityDto,
  ) {
    const user = req.user as UserPayload;
    const { dueDate, ...rest } = dto;

    // `dueDate` arrives as an ISO string (that is what IsDateString validates)
    // and the column is a Date. Converting here rather than letting TypeORM
    // coerce keeps an unparseable value from reaching Postgres as a literal.
    return this.crmService.updateEntity(
      id,
      user.tenantId,
      this.actorFrom(user),
      {
        ...rest,
        ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
      },
      // Selects the pack whose `relationships[]` say what blocks completion.
      // PolicyGuard has already resolved it.
      (req as AuthenticatedRequest).tenantVertical ?? null,
    );
  }

  @Post('entities/:id/acceptance')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Record that someone accepted something',
    description:
      '**This is not an electronic signature and the response says so** ' +
      '(`isSignature: false`). It is an audited record of assent: who, when, ' +
      'from where, and — when `documentSha256` is supplied — a hash anchoring ' +
      'exactly which bytes they were shown.\n\n' +
      'For an immigration engagement letter, "the client ticked a box" and "the ' +
      'client signed" are not equivalent, and only one is enforceable the way a ' +
      'firm will assume. A UI collecting this must say which it is. Real ' +
      'e-signature needs a provider or a certificate authority — a commercial ' +
      'decision, on the same list as the regulator licences.\n\n' +
      'Supply the hash. Without it the record shows that somebody clicked ' +
      'something, not what they agreed to, and the wording can change afterwards ' +
      'with nothing to detect it. `POST /documents/generate/:key` gives you the ' +
      'bytes to hash.\n\n' +
      'Acceptances append. Accepting revised terms does not erase the version ' +
      'agreed to first, which is the one that governs what happened before.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Acceptance recorded' })
  @ApiResponse({ status: 404, description: 'No such record on this tenant' })
  async recordAcceptance(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordAcceptanceDto,
  ) {
    const user = req.user as UserPayload;
    return this.acceptance.record(
      user.tenantId,
      id,
      {
        subject: dto.subject,
        userId: user.id,
        email: user.email,
        // From the request, never the body: a client-supplied "I accepted
        // from this address" is not evidence of anything.
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        documentSha256: dto.documentSha256,
      },
      this.actorFrom(user),
    );
  }

  @Get('entities/:id/acceptance')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Every acceptance on a record, oldest first',
    description:
      'Each carries `isSignature: false`. Render them as a history — the ' +
      'earliest acceptance is what governed the period before any later one.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async listAcceptances(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user as UserPayload;
    return this.acceptance.list(user.tenantId, id, this.actorFrom(user));
  }

  @Post('entities/:id/convert')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Change a record's type, keeping its id and its history",
    description:
      'What lead conversion needs. `PATCH` refuses `type` so a stray key in a ' +
      'form payload cannot reinterpret a record; this does it explicitly and ' +
      '**keeps the same id**, so the comments, documents, tasks, payments and ' +
      'messages already filed against the lead stay attached to the client. ' +
      'Creating a new record instead leaves all of that hanging off a row the ' +
      'UI no longer shows.\n\n' +
      'Permitted transitions are constrained — `lead` → `person`/`organization`, ' +
      'and `person` ↔ `organization`. Anything else is a 400 naming what is ' +
      'allowed. The previous type is recorded under ' +
      '`verticalAttributes.conversion`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Entity converted' })
  @ApiResponse({
    status: 400,
    description: 'Already that type, or the transition is not permitted',
  })
  @ApiResponse({ status: 404, description: 'No such entity on this tenant' })
  async convertEntity(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertEntityDto,
  ) {
    const user = req.user as UserPayload;
    return this.crmService.convertEntity(
      id,
      user.tenantId,
      this.actorFrom(user),
      dto.toType,
      (req as AuthenticatedRequest).tenantVertical ?? null,
    );
  }

  // PUT alias for PATCH. Separate handler on purpose — stacking `@Put()` and
  // `@Patch()` on one method registers only one verb, because both write the
  // same metadata key.
  @Put('entities/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update a CRM entity (alias of PATCH)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Entity updated' })
  async replaceEntity(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntityDto,
  ) {
    return this.updateEntity(req, id, dto);
  }

  // ── Typed relationships ───────────────────────────────────────────────────

  @Post('entities/:id/relations')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Link two entities with a relation the pack defines',
    description:
      'Document relationships, task and milestone dependencies and ' +
      'counterparty links are all this route. The relation key must exist in ' +
      "the vertical's `relationships[]`, and the two entity types must match " +
      'what it declares — an edge that matches no definition is invisible ' +
      'until someone asks why a dependency is not blocking anything.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The "from" entity' })
  @ApiResponse({ status: 201, description: 'Relation created (idempotent)' })
  @ApiResponse({
    status: 400,
    description: 'Unknown relation key, wrong types, or cardinality violated',
  })
  async link(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkEntitiesDto,
  ) {
    const user = req.user as UserPayload;
    return this.relations.link(
      user.tenantId,
      this.actorFrom(user),
      (req as AuthenticatedRequest).tenantVertical ?? null,
      dto.relationKey,
      id,
      dto.toId,
      user.id,
    );
  }

  @Get('entities/:id/relations')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Everything linked to this entity, both directions',
    description:
      "Incoming edges are labelled with the relation's `inverseLabel`, so " +
      '"blocks" one way and "blocked by" the other come from one definition ' +
      'rather than two mirrored ones.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Outgoing and incoming relations' })
  async relationsFor(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user as UserPayload;
    return this.relations.traverse(
      user.tenantId,
      this.actorFrom(user),
      (req as AuthenticatedRequest).tenantVertical ?? null,
      id,
    );
  }

  @Get('entities/:id/blockers')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Related records that must finish before this one may close',
    description:
      'The same check the update route enforces, exposed so a UI can grey ' +
      'out the close button instead of letting someone press it and read an ' +
      'error.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async blockers(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user as UserPayload;
    return this.relations.completionBlockers(
      user.tenantId,
      this.actorFrom(user),
      (req as AuthenticatedRequest).tenantVertical ?? null,
      id,
    );
  }

  @Get('entities/:id/rules')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: "The pack's declarative rules, evaluated against this record",
    description:
      'Evaluates `rules[]` from the tenant\'s config pack over the record. ' +
      'Read-only: nothing here blocks a write. `violations` lists the rules ' +
      'that matched; `skipped` lists rules the evaluator refused because the ' +
      'record lacks a compared field — those are unknown, not passed, and a ' +
      'UI must not render them as clean. `blocked` is true when an ' +
      '`error`-severity rule matched.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Rule evaluation report' })
  @ApiResponse({ status: 404, description: 'No such entity on this tenant' })
  async rulesFor(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user as UserPayload;
    const entity = await this.crmService.getEntity(
      id,
      user.tenantId,
      this.actorFrom(user),
    );
    return this.packRules.evaluate(
      (req as AuthenticatedRequest).tenantVertical ?? null,
      entity as unknown as Record<string, unknown>,
    );
  }

  @Delete('entities/:id/relations/:relationKey/:toId')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Remove a relation' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'toId', format: 'uuid' })
  async unlink(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('relationKey') relationKey: string,
    @Param('toId', ParseUUIDPipe) toId: string,
  ) {
    const user = req.user as UserPayload;
    await this.relations.unlink(
      user.tenantId,
      this.actorFrom(user),
      relationKey,
      id,
      toId,
    );
    return { removed: true };
  }
}
