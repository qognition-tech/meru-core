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
import {
  CalendarEventsQueryDto,
  ListTasksQueryDto,
} from './dto/task-query.dto';
import { CreateTaskDto, UpdateTaskDto } from './dto/create-task.dto';
import { CreateRecurringJobDto } from './dto/create-recurring-job.dto';

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
  async createTask(@Request() req, @Body() dto: CreateTaskDto) {
    // Dates arrive as ISO strings (IsDateString) and the service takes Date.
    // `assignedBy` comes from the JWT, never the body — accepting it from a
    // caller would let anyone attribute a task to somebody else.
    const task = await this.taskService.createTask(req.user.tenantId, {
      ...dto,
      assignedBy: req.user.id,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      reminderDate: dto.reminderDate ? new Date(dto.reminderDate) : undefined,
    });
    return task;
  }

  @Get()
  @ApiOperation({ summary: 'List tasks' })
  @ApiResponse({ status: 200, description: 'Tasks retrieved' })
  @ApiResponse({ status: 400, description: 'Unknown or malformed query param' })
  async listTasks(@Request() req, @Query() query: ListTasksQueryDto) {
    return this.taskService.listTasks(req.user.tenantId, query);
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
    return work;
  }

  // ── Literal paths, declared before `:id` ──────────────────────────────────
  //
  // Nest matches routes in declaration order. Both of these used to sit further
  // down the file, below `@Get(':id')`, so `/tasks/recurring-jobs` and
  // `/tasks/calendar/events` never reached their handlers — they resolved as
  // `getTask('recurring-jobs')` and 400'd on ParseUUIDPipe. Keep them here.

  @Get('recurring-jobs')
  @ApiOperation({ summary: 'List recurring jobs' })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'Jobs retrieved' })
  async listRecurringJobs(@Request() req, @Query('status') status?: string) {
    return this.taskService.listRecurringJobs(req.user.tenantId, status as any);
  }

  @Get('calendar/events')
  @ApiOperation({ summary: 'Get calendar events' })
  @ApiResponse({ status: 200, description: 'Events retrieved' })
  @ApiResponse({ status: 400, description: 'Missing or malformed date range' })
  async getCalendarEvents(
    @Request() req,
    @Query() query: CalendarEventsQueryDto,
  ) {
    return this.taskService.getCalendarEvents(
      req.user.tenantId,
      req.user.id,
      new Date(query.startDate),
      new Date(query.endDate),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get task by ID' })
  @ApiResponse({ status: 200, description: 'Task retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getTask(@Param('id', ParseUUIDPipe) id: string) {
    const task = await this.taskService.getTask(id);
    return task;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update task' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  async updateTask(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    const { dueDate, ...rest } = dto;
    const task = await this.taskService.updateTask(id, req.user.tenantId, {
      ...rest,
      ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
    });
    return task;
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
    return task;
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
    return task;
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
    return task;
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
    return comment;
  }

  // ==================== RECURRING JOBS ====================

  @Post('recurring-jobs')
  @ApiOperation({ summary: 'Create a recurring job' })
  @ApiResponse({ status: 201, description: 'Recurring job created' })
  async createRecurringJob(@Request() req, @Body() dto: CreateRecurringJobDto) {
    // The DTO guarantees name, a parseable cron `schedule` and a taskTemplate
    // object. The template's inner shape mirrors CreateTaskDto and is applied
    // when the job fires, so it is carried through rather than duplicated here.
    const job = await this.taskService.createRecurringJob(
      req.user.tenantId,
      dto as unknown as Parameters<
        typeof this.taskService.createRecurringJob
      >[1],
    );
    return job;
  }

  @Post('recurring-jobs/:id/pause')
  @ApiOperation({ summary: 'Pause recurring job' })
  @ApiResponse({ status: 200, description: 'Job paused' })
  async pauseRecurringJob(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const job = await this.taskService.pauseRecurringJob(id, req.user.tenantId);
    return job;
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
    return job;
  }

  // ==================== CALENDAR ====================
  // GET calendar/events lives near the top of this file — see the note there
  // about literal paths having to precede `@Get(':id')`.

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
    return result;
  }
}
