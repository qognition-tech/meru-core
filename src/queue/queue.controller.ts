import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { QueueService } from './queue.service';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { TenantId } from '../tenant/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../iam/guards/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import {
  CreateJobDto,
  ScheduleJobDto,
  JobFilterDto,
  BulkJobDto,
  RetryJobDto,
  JobProgressDto,
} from './dto/job.dto';
import {
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
} from './entities/job.entity';
import {
  QueueMetrics,
  JobStatus,
  JobType,
  JobPriority,
} from './interfaces/job.interface';

@ApiTags('Queue')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  // ==================== JOB MANAGEMENT ====================

  @Post('jobs')
  @ApiOperation({
    summary: 'Create job',
    description: 'Create a new background job',
  })
  @ApiResponse({
    status: 201,
    description: 'Job created successfully',
    type: QueueJob,
  })
  async createJob(
    @Body() dto: CreateJobDto,
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<QueueJob> {
    return this.queueService.createJob(
      tenantId,
      dto.type,
      {
        payload: dto.payload,
        metadata: { tags: dto.tags },
      },
      {
        priority: dto.priority,
        delay: dto.delay,
        attempts: dto.attempts,
        timeout: dto.timeout,
      },
      userId,
    );
  }

  @Post('jobs/bulk')
  @ApiOperation({
    summary: 'Create bulk jobs',
    description: 'Create multiple jobs at once',
  })
  @ApiResponse({
    status: 201,
    description: 'Jobs created successfully',
    type: [QueueJob],
  })
  async createBulkJobs(
    @Body() dto: BulkJobDto,
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<QueueJob[]> {
    return this.queueService.createBulkJobs(
      tenantId,
      dto.jobs.map((j) => ({
        type: j.type,
        data: {
          payload: j.payload,
          metadata: { tags: j.tags },
        },
        options: {
          priority: j.priority,
          delay: j.delay,
          attempts: j.attempts,
          timeout: j.timeout,
        },
      })),
      userId,
    );
  }

  @Get('jobs')
  @ApiOperation({
    summary: 'List jobs',
    description: 'List jobs with optional filtering',
  })
  @ApiResponse({ status: 200, description: 'Jobs retrieved successfully' })
  async listJobs(
    @TenantId() tenantId: string,
    @Query() filter: JobFilterDto,
  ): Promise<{ jobs: QueueJob[]; total: number }> {
    return this.queueService.getJobs(
      {
        tenantId,
        status: filter.status,
        type: filter.type,
        priority: filter.priority,
      },
      filter.page,
      filter.limit,
    );
  }

  @Get('jobs/:id')
  @ApiOperation({
    summary: 'Get job details',
    description: 'Get detailed information about a job',
  })
  @ApiResponse({
    status: 200,
    description: 'Job retrieved successfully',
    type: QueueJob,
  })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJob(
    @Param('id', ParseUUIDPipe) jobId: string,
    @TenantId() tenantId: string,
  ): Promise<QueueJob> {
    return this.queueService.getJob(jobId, tenantId);
  }

  @Get('jobs/:id/logs')
  @ApiOperation({
    summary: 'Get job logs',
    description: 'Get execution logs for a job',
  })
  @ApiResponse({
    status: 200,
    description: 'Logs retrieved successfully',
    type: [QueueJobLog],
  })
  async getJobLogs(
    @Param('id', ParseUUIDPipe) jobId: string,
    @TenantId() tenantId: string,
  ): Promise<QueueJobLog[]> {
    // Verify job exists and belongs to tenant
    await this.queueService.getJob(jobId, tenantId);
    return this.queueService.getJobLogs(jobId);
  }

  @Post('jobs/:id/retry')
  @ApiOperation({
    summary: 'Retry job',
    description: 'Retry a failed or cancelled job',
  })
  @ApiResponse({
    status: 200,
    description: 'Job queued for retry',
    type: QueueJob,
  })
  async retryJob(
    @Param('id', ParseUUIDPipe) jobId: string,
    @Body() dto: RetryJobDto,
    @TenantId() tenantId: string,
  ): Promise<QueueJob> {
    return this.queueService.retryJob(jobId, tenantId, dto.delay);
  }

  @Delete('jobs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel job',
    description: 'Cancel a pending or processing job',
  })
  @ApiResponse({ status: 204, description: 'Job cancelled successfully' })
  async cancelJob(
    @Param('id', ParseUUIDPipe) jobId: string,
    @TenantId() tenantId: string,
  ): Promise<void> {
    await this.queueService.cancelJob(jobId, tenantId);
  }

  @Delete('jobs/:id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove job',
    description: 'Permanently remove a job and its logs',
  })
  @ApiResponse({ status: 204, description: 'Job removed successfully' })
  async removeJob(
    @Param('id', ParseUUIDPipe) jobId: string,
    @TenantId() tenantId: string,
  ): Promise<void> {
    await this.queueService.getJob(jobId, tenantId);
    await this.queueService.removeJob(jobId);
  }

  // ==================== SCHEDULED JOBS ====================

  @Post('scheduled')
  @ApiOperation({
    summary: 'Schedule recurring job',
    description: 'Create a cron-based recurring job',
  })
  @ApiResponse({
    status: 201,
    description: 'Scheduled job created',
    type: QueueScheduledJob,
  })
  async scheduleJob(
    @Body() dto: ScheduleJobDto,
    @TenantId() tenantId: string,
  ): Promise<QueueScheduledJob> {
    return this.queueService.scheduleJob(
      tenantId,
      (dto.payload.name as string) || 'Scheduled Job',
      dto.type,
      {
        payload: dto.payload,
      },
      dto.cronExpression,
      {
        endDate: dto.endDate,
        maxRuns: dto.maxRuns,
      },
    );
  }

  @Get('scheduled')
  @ApiOperation({
    summary: 'List scheduled jobs',
    description: 'List all recurring scheduled jobs',
  })
  @ApiResponse({
    status: 200,
    description: 'Scheduled jobs retrieved',
    type: [QueueScheduledJob],
  })
  async listScheduledJobs(
    @TenantId() tenantId: string,
  ): Promise<QueueScheduledJob[]> {
    return this.queueService.scheduledRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  @Delete('scheduled/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel scheduled job',
    description: 'Cancel a recurring scheduled job',
  })
  @ApiResponse({ status: 204, description: 'Scheduled job cancelled' })
  async cancelScheduledJob(
    @Param('id', ParseUUIDPipe) id: string,
    @TenantId() tenantId: string,
  ): Promise<void> {
    await this.queueService.cancelScheduledJob(id, tenantId);
  }

  // ==================== METRICS ====================

  @Get('metrics')
  @ApiOperation({
    summary: 'Get queue metrics',
    description: 'Get queue statistics and metrics',
  })
  @ApiResponse({ status: 200, description: 'Metrics retrieved successfully' })
  async getMetrics(@TenantId() tenantId: string): Promise<QueueMetrics> {
    return this.queueService.getMetrics(tenantId);
  }

  // ==================== JOB TYPES ====================

  @Get('types')
  @ApiOperation({
    summary: 'Get job types',
    description: 'List all available job types',
  })
  @ApiResponse({ status: 200, description: 'Job types retrieved' })
  getJobTypes(): { type: string; description: string }[] {
    return [
      { type: 'ai:analysis', description: 'AI content analysis' },
      { type: 'ai:embedding', description: 'Generate vector embeddings' },
      { type: 'document:process', description: 'Process document' },
      { type: 'document:ocr', description: 'OCR document' },
      { type: 'email:send', description: 'Send email' },
      { type: 'sms:send', description: 'Send SMS' },
      { type: 'data:export', description: 'Export data' },
      { type: 'data:import', description: 'Import data' },
      { type: 'report:generate', description: 'Generate report' },
      { type: 'billing:invoice', description: 'Generate invoice' },
    ];
  }
}
