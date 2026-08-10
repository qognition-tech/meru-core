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
import { ListEntitiesQueryDto, UpdateEntityDto } from './dto/update-entity.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { UserPayload, type AuthenticatedRequest } from '../common/types';
import { EntityRelationService } from './entity-relation.service';
import { CommentService } from './comment.service';
import { AddCommentDto } from './dto/add-comment.dto';
import { LinkEntitiesDto } from './dto/link-entities.dto';
import { paginated } from '../common/paginated';

@Controller('crm')
@ApiTags('crm')
export class CrmController {
  constructor(
    private crmService: CrmService,
    private relations: EntityRelationService,
    private readonly comments: CommentService,
  ) {}

  // ==================== COMMENTS ====================
  //
  // Any record, not just tasks. Document annotations, case file notes and
  // breach investigation notes are one feature wearing three names.

  @Post('entities/:id/comments')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Comment on a record' })
  @ApiResponse({ status: 201, description: 'Comment added' })
  @ApiResponse({ status: 400, description: 'Empty body, or no such record here' })
  addComment(
    @Request() req: ExpressRequest,
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
  ) {
    const user = req.user as UserPayload;
    return this.comments.add(user.tenantId, 'record', id, {
      body: dto.body,
      authorId: user.id,
      internal: dto.internal,
    });
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
    return this.comments.list(user.tenantId, id, {
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
    return this.comments.remove(user.tenantId, id);
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

    // A `client` is an applicant, not staff: they may see only records
    // assigned to them. RLS isolates one tenant from another, it does NOT
    // isolate users inside a tenant — so without this a client token
    // received every case in the firm. ImmiStack filtered in the browser,
    // which is presentation, not authorisation.
    //
    // Forced rather than defaulted: a client cannot widen it by passing
    // ?assignedTo= for somebody else.
    const scoped =
      (user.roles ?? []).includes(PlatformRole.CLIENT) &&
      !(user.roles ?? []).some((r) =>
        [
          PlatformRole.PLATFORM_ADMIN,
          PlatformRole.FIRM_ADMIN,
          PlatformRole.STAFF,
        ].includes(r as PlatformRole),
      )
        ? { ...query, assignedTo: user.id }
        : query;

    const { items, total, page, limit } = await this.crmService.listEntities(
      user.tenantId,
      scoped,
    );
    return paginated(items, total, page, limit);
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
    return this.crmService.getEntity(id, user.tenantId);
  }

  @Patch('entities/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Update a CRM entity (partial)',
    description:
      'The write half of the registers and the kanban: status transitions, ' +
      'reassignment, due-date changes. `verticalAttributes` is merged, not ' +
      'replaced. Tenant and type are immutable here.',
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
      {
        ...rest,
        ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
      },
      // Selects the pack whose `relationships[]` say what blocks completion.
      // PolicyGuard has already resolved it.
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
  @ApiResponse({ status: 400, description: 'Unknown relation key, wrong types, or cardinality violated' })
  async link(
    @Request() req: ExpressRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkEntitiesDto,
  ) {
    const user = req.user as UserPayload;
    return this.relations.link(
      user.tenantId,
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
      'Incoming edges are labelled with the relation\'s `inverseLabel`, so ' +
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
      (req as AuthenticatedRequest).tenantVertical ?? null,
      id,
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
    await this.relations.unlink(user.tenantId, relationKey, id, toId);
    return { removed: true };
  }
}
