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
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { StartWorkflowDto } from './dto/start-workflow.dto';
import { TransitionDto } from './dto/transition.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';

@ApiTags('workflows')
@Controller('workflows')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class WorkflowController {
  constructor(private workflowService: WorkflowEngineService) {}

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
    return {
      success: true,
      data: workflow,
    };
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
    return {
      success: true,
      data: workflows,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get workflow by ID' })
  @ApiResponse({ status: 200, description: 'Workflow retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getWorkflow(@Param('id', ParseUUIDPipe) id: string) {
    const workflow = await this.workflowService.getWorkflow(id);
    return {
      success: true,
      data: workflow,
    };
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
    return {
      success: true,
      data: instance,
    };
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
    return {
      success: true,
      data: instances,
    };
  }

  @Get('instances/:id')
  @ApiOperation({ summary: 'Get workflow instance by ID' })
  @ApiResponse({ status: 200, description: 'Instance retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getInstance(@Param('id', ParseUUIDPipe) id: string) {
    const instance = await this.workflowService.getInstance(id);
    return {
      success: true,
      data: instance,
    };
  }

  @Get('instances/:id/transitions')
  @ApiOperation({ summary: 'Get available transitions for instance' })
  @ApiResponse({ status: 200, description: 'Transitions retrieved' })
  async getAvailableTransitions(@Param('id', ParseUUIDPipe) id: string) {
    const transitions = await this.workflowService.getAvailableTransitions(id);
    return {
      success: true,
      data: transitions,
    };
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
    return {
      success: true,
      data: instance,
    };
  }
}
