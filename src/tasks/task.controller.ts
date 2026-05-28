import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
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
import { TaskService } from './task.service';
import { PolicyGuard } from '../iam/guards/policy.guard';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class TaskController {
  constructor(private taskService: TaskService) {}

  // ==================== TASKS ====================

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  @ApiResponse({ status: 201, description: 'Task created successfully' })
  async createTask(@Request() req, @Body() dto: any) {
    const task = await this.taskService.createTask(req.user.tenantId, {
      ...dto,
      assignedBy: req.user.id,
    });
    return {
      success: true,
      data: task,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List tasks' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiResponse({ status: 200, description: 'Tasks retrieved' })
  async listTasks(
    @Request() req,
    @Query('status') status?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('priority') priority?: string,
    @Query('type') type?: string,
  ) {
    const tasks = await this.taskService.listTasks(req.user.tenantId, {
      status: status as any,
      assignedTo,
      priority: priority as any,
      type: type as any,
    });
    return {
      success: true,
      data: tasks,
    };
  }

  @Get('my-work')
  @ApiOperation({ summary: 'Get my work (unified inbox)' })
  @ApiQuery({ name: 'includeCompleted', required: false })
  @ApiResponse({ status: 200, description: 'My work retrieved' })
  async getMyWork(
    @Request() req,
    @Query('includeCompleted') includeCompleted?: string,
  ) {
    const work = await this.taskService.getMyWork(
      req.user.tenantId,
      req.user.id,
      {
        includeCompleted: includeCompleted === 'true',
      },
    );
    return {
      success: true,
      data: work,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get task by ID' })
  @ApiResponse({ status: 200, description: 'Task retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getTask(@Param('id', ParseUUIDPipe) id: string) {
    const task = await this.taskService.getTask(id);
    return {
      success: true,
      data: task,
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update task' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  async updateTask(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: any,
  ) {
    const task = await this.taskService.updateTask(id, req.user.tenantId, dto);
    return {
      success: true,
      data: task,
    };
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start task' })
  @ApiResponse({ status: 200, description: 'Task started' })
  async startTask(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const task = await this.taskService.startTask(
      id,
      req.user.tenantId,
      req.user.id,
    );
    return {
      success: true,
      data: task,
    };
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Complete task' })
  @ApiResponse({ status: 200, description: 'Task completed' })
  async completeTask(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const task = await this.taskService.completeTask(
      id,
      req.user.tenantId,
      req.user.id,
    );
    return {
      success: true,
      data: task,
    };
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel task' })
  @ApiResponse({ status: 200, description: 'Task cancelled' })
  async cancelTask(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason?: string },
  ) {
    const task = await this.taskService.cancelTask(
      id,
      req.user.tenantId,
      dto.reason,
    );
    return {
      success: true,
      data: task,
    };
  }

  // ==================== TASK COMMENTS ====================

  @Post(':id/comments')
  @ApiOperation({ summary: 'Add comment to task' })
  @ApiResponse({ status: 201, description: 'Comment added' })
  async addComment(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { content: string },
  ) {
    const comment = await this.taskService.addComment(
      id,
      req.user.tenantId,
      req.user.id,
      dto.content,
    );
    return {
      success: true,
      data: comment,
    };
  }

  // ==================== RECURRING JOBS ====================

  @Post('recurring-jobs')
  @ApiOperation({ summary: 'Create a recurring job' })
  @ApiResponse({ status: 201, description: 'Recurring job created' })
  async createRecurringJob(@Request() req, @Body() dto: any) {
    const job = await this.taskService.createRecurringJob(
      req.user.tenantId,
      dto,
    );
    return {
      success: true,
      data: job,
    };
  }

  @Get('recurring-jobs')
  @ApiOperation({ summary: 'List recurring jobs' })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'Jobs retrieved' })
  async listRecurringJobs(@Request() req, @Query('status') status?: string) {
    const jobs = await this.taskService.listRecurringJobs(
      req.user.tenantId,
      status as any,
    );
    return {
      success: true,
      data: jobs,
    };
  }

  @Post('recurring-jobs/:id/pause')
  @ApiOperation({ summary: 'Pause recurring job' })
  @ApiResponse({ status: 200, description: 'Job paused' })
  async pauseRecurringJob(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const job = await this.taskService.pauseRecurringJob(id, req.user.tenantId);
    return {
      success: true,
      data: job,
    };
  }

  @Post('recurring-jobs/:id/resume')
  @ApiOperation({ summary: 'Resume recurring job' })
  @ApiResponse({ status: 200, description: 'Job resumed' })
  async resumeRecurringJob(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const job = await this.taskService.resumeRecurringJob(
      id,
      req.user.tenantId,
    );
    return {
      success: true,
      data: job,
    };
  }

  // ==================== CALENDAR ====================

  @Get('calendar/events')
  @ApiOperation({ summary: 'Get calendar events' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiResponse({ status: 200, description: 'Events retrieved' })
  async getCalendarEvents(
    @Request() req,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    const events = await this.taskService.getCalendarEvents(
      req.user.tenantId,
      req.user.id,
      new Date(startDate),
      new Date(endDate),
    );
    return {
      success: true,
      data: events,
    };
  }

  @Post('calendar/sync/:provider')
  @ApiOperation({ summary: 'Sync with external calendar' })
  @ApiResponse({ status: 200, description: 'Sync initiated' })
  async syncCalendar(
    @Request() req,
    @Param('provider') provider: 'google' | 'outlook',
  ) {
    const result = await this.taskService.syncWithExternalCalendar(
      req.user.tenantId,
      req.user.id,
      provider,
    );
    return {
      success: result.success,
      data: result,
    };
  }
}
