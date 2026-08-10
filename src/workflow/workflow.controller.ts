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

@ApiTags('workflows')
@Controller('workflows')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class WorkflowController {
  constructor(
    private workflowService: WorkflowEngineService,
    private readonly tat: TatService,
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
  async getWorkflow(@Param('id', ParseUUIDPipe) id: string) {
    const workflow = await this.workflowService.getWorkflow(id);
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
  @ApiOperation({ summary: 'List workflow instances' })
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
      status as any,
      entityId,
    );
    return instances;
  }

  @Get('instances/:id')
  @ApiOperation({ summary: 'Get workflow instance by ID' })
  @ApiResponse({ status: 200, description: 'Instance retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getInstance(@Param('id', ParseUUIDPipe) id: string) {
    const instance = await this.workflowService.getInstance(id);
    return instance;
  }

  @Get('instances/:id/transitions')
  @ApiOperation({ summary: 'Get available transitions for instance' })
  @ApiResponse({ status: 200, description: 'Transitions retrieved' })
  async getAvailableTransitions(@Param('id', ParseUUIDPipe) id: string) {
    const transitions = await this.workflowService.getAvailableTransitions(id);
    return transitions;
  }

  @Post('instances/:id/transition')
  @ApiOperation({ summary: 'Execute a state transition' })
  @ApiResponse({ status: 200, description: 'Transition executed' })
  async transition(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionDto,
  ) {
    const instance = await this.workflowService.transition({
      instanceId: id,
      transitionId: dto.transitionId,
      userId: req.user.id,
      context: dto.context,
    });
    return instance;
  }
}
