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
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { Request as ExpressRequest } from 'express';
import { CrmService } from './crm.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { ListEntitiesQueryDto, UpdateEntityDto } from './dto/update-entity.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { UserPayload } from '../common/types';
import { paginated } from '../common/paginated';

@Controller('crm')
@ApiTags('crm')
export class CrmController {
  constructor(private crmService: CrmService) {}

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
    const { items, total, page, limit } = await this.crmService.listEntities(
      user.tenantId,
      query,
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
    return this.crmService.updateEntity(id, user.tenantId, {
      ...rest,
      ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
    });
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
}
