import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { WorkflowEngineService } from './workflow.service';
import { TatService } from './services/tat.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { StartWorkflowDto } from './dto/start-workflow.dto';
import { TransitionDto } from './dto/transition.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PackWorkflowService } from './services/pack-workflow.service';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';

@ApiTags('workflows')
@Controller('workflows')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class WorkflowController {
  constructor(
    private workflowService: WorkflowEngineService,
    private readonly tat: TatService,
    private readonly packWorkflows: PackWorkflowService,
  ) {}

  // ==================== TURNAROUND TIME ====================
  //
  // Declared before the `:id` routes below: Nest matches in declaration order,
  // and `instances/tat` would otherwise be read as an instance id.

  @Get('tat')
  @ApiOperation({
    summary: 'Stage turnaround times, aggregated across instances',
    description:
      'Median and p90 alongside the mean, because one stalled case moves a ' +
      'mean on its own. Stages still in progress are excluded — an open stage ' +
      'has not turned around yet. `breachRate: null` means no entry in that ' +
      'stage declared an SLA to breach.',
  })
  @ApiQuery({ name: 'workflowId', required: false })
  @ApiQuery({ name: 'since', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async tatAggregate(
    @Request() req,
    @Query('workflowId') workflowId?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tat.aggregate(req.user.tenantId, {
      workflowId,
      since: since ? new Date(since) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('instances/:id/tat')
  @ApiOperation({
    summary: 'Per-stage turnaround for one instance',
    description:
      'Derived from the instance transition history, so it cannot drift from ' +
      'the record it describes. The final entry is the stage the record is ' +
      'in now and is marked `open`.',
  })
  @ApiResponse({ status: 404, description: 'No such instance for this tenant' })
  async tatForInstance(@Request() req, @Param('id') id: string) {
    return this.tat.forInstance(req.user.tenantId, id);
  }

  // ==================== PACK WORKFLOWS (Layer 4) ====================

  @Get('pack')
  @ApiOperation({
    summary: "The config pack's workflow definitions, as authored",
    description:
      'What `POST /workflows/pack/materialise` turns into runnable ' +
      'workflows. Read-only; a pack workflow is not startable until it has ' +
      'been materialised for this tenant.',
  })
  @ApiResponse({ status: 200, description: 'Pack workflow definitions' })
  async listPackWorkflows(@Request() req) {
    return this.packWorkflows.list(req.tenantVertical ?? null);
  }

  @Post('pack/materialise')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: "Create runnable workflows from the pack's definitions",
    description:
      'Idempotent per pack workflow id: an already-materialised workflow is ' +
      'reported under `existing`, not duplicated. Transition conditions are ' +
      'compiled to JsonLogic; one that cannot compile is listed under ' +
      '`unevaluableConditions` and that transition never opens.',
  })
  @ApiQuery({ name: 'workflowId', required: false, description: 'Only this pack workflow id' })
  @ApiResponse({ status: 201, description: 'Materialisation report' })
  async materialisePackWorkflows(
    @Request() req,
    @Query('workflowId') workflowId?: string,
  ) {
    return this.packWorkflows.materialise(
      req.user.tenantId,
      req.tenantVertical ?? null,
      req.user.id,
      workflowId || undefined,
    );
  }

  // ==================== WORKFLOW DEFINITIONS ====================

  @Post()
  @ApiOperation({ summary: 'Create a new workflow definition' })
  @ApiResponse({ status: 201, description: 'Workflow created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async createWorkflow(@Request() req, @Body() dto: CreateWorkflowDto) {
    const workflow = await this.workflowService.createWorkflow(
      req.user.tenantId,
      dto,
      req.user.id,
    );
    return workflow;
  }

  @Get()
  @ApiOperation({ summary: 'List all workflows' })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiResponse({ status: 200, description: 'Workflows retrieved' })
  async listWorkflows(
    @Request() req,
    @Query('entityType') entityType?: string,
  ) {
    const workflows = await this.workflowService.listWorkflows(
      req.user.tenantId,
      entityType,
    );
    return workflows;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get workflow by ID' })
  @ApiResponse({ status: 200, description: 'Workflow retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getWorkflow(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const workflow = await this.workflowService.getWorkflow(
      id,
      req.user.tenantId,
    );
    return workflow;
  }

  // ==================== WORKFLOW INSTANCES ====================

  @Post('instances')
  @ApiOperation({ summary: 'Start a new workflow instance' })
  @ApiResponse({ status: 201, description: 'Instance started' })
  async startWorkflow(@Request() req, @Body() dto: StartWorkflowDto) {
    const instance = await this.workflowService.startWorkflow(
      dto.workflowId,
      dto.entityId,
      dto.entityType,
      req.user.tenantId,
      req.user.id,
      dto.context,
    );
    return instance;
  }

  @Get('instances')
  @ApiOperation({
    summary: 'List workflow instances',
    description:
      "A client sees only their own matters — the ones they started, or " +
      "ones linked to a CRM record assigned to them; staff see every " +
      "instance in the tenant. Same rule as GET /workflows/instances/:id, " +
      "applied to the list.",
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiResponse({ status: 200, description: 'Instances retrieved' })
  async listInstances(
    @Request() req,
    @Query('status') status?: string,
    @Query('entityId') entityId?: string,
  ) {
    const instances = await this.workflowService.listInstances(
      req.user.tenantId,
      req.user,
      status as any,
      entityId,
    );
    return instances;
  }

  @Get('instances/:id')
  @ApiOperation({
    summary: 'Get workflow instance by ID',
    description:
      "A client reaches only their own matter — the instance they started, " +
      "or one linked to a CRM record assigned to them; staff reach any " +
      "instance in the tenant.",
  })
  @ApiResponse({ status: 200, description: 'Instance retrieved' })
  @ApiResponse({ status: 404, description: "Not found, or not this caller's" })
  async getInstance(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const instance = await this.workflowService.getInstance(
      id,
      req.user.tenantId,
      req.user,
    );
    return instance;
  }

  @Get('instances/:id/transitions')
  @ApiOperation({ summary: 'Get available transitions for instance' })
  @ApiResponse({ status: 200, description: 'Transitions retrieved' })
  @ApiResponse({ status: 404, description: "Not found, or not this caller's" })
  async getAvailableTransitions(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const transitions = await this.workflowService.getAvailableTransitions(
      id,
      req.user.tenantId,
      req.user,
    );
    return transitions;
  }

  @Post('instances/:id/transition')
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: 'Execute a state transition',
    description:
      'Staff only — advancing a matter to its next stage is a case decision, ' +
      "not a checklist action a client performs on their own record.",
  })
  @ApiResponse({ status: 200, description: 'Transition executed' })
  async transition(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionDto,
  ) {
    const instance = await this.workflowService.transition({
      instanceId: id,
      tenantId: req.user.tenantId,
      transitionId: dto.transitionId,
      userId: req.user.id,
      // Needed by `checkPermissions`: a transition materialised from a pack
      // carries `permissions.roles` and no `users`, so the actor's own roles
      // are the only thing that can satisfy it.
      userRoles: req.user.roles ?? [],
      context: dto.context,
    });
    return instance;
  }
}
