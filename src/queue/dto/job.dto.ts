import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsArray,
  IsNumber,
  Min,
  Max,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JobType, JobPriority, JobStatus } from '../interfaces/job.interface';

export class CreateJobDto {
  @ApiProperty({ description: 'Job type', enum: JobType })
  @IsEnum(JobType)
  type: JobType;

  @ApiProperty({ description: 'Job payload data' })
  @IsObject()
  payload: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Job priority',
    enum: JobPriority,
    default: JobPriority.NORMAL,
  })
  @IsOptional()
  @IsEnum(JobPriority)
  priority?: JobPriority;

  @ApiPropertyOptional({ description: 'Delay in milliseconds' })
  @IsOptional()
  @IsNumber()
  delay?: number;

  @ApiPropertyOptional({ description: 'Maximum retry attempts', default: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  attempts?: number;

  @ApiPropertyOptional({ description: 'Job timeout in milliseconds' })
  @IsOptional()
  @IsNumber()
  timeout?: number;

  @ApiPropertyOptional({ description: 'Job tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class ScheduleJobDto extends CreateJobDto {
  @ApiProperty({ description: 'Cron expression for recurring jobs' })
  @IsString()
  cronExpression: string;

  @ApiPropertyOptional({ description: 'End date for recurring job' })
  @IsOptional()
  endDate?: Date;

  @ApiPropertyOptional({ description: 'Maximum number of runs' })
  @IsOptional()
  @IsNumber()
  maxRuns?: number;
}

export class JobFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: JobStatus,
    isArray: true,
  })
  @IsOptional()
  status?: JobStatus | JobStatus[];

  @ApiPropertyOptional({
    description: 'Filter by type',
    enum: JobType,
    isArray: true,
  })
  @IsOptional()
  type?: JobType | JobType[];

  @ApiPropertyOptional({ description: 'Filter by priority', enum: JobPriority })
  @IsOptional()
  priority?: JobPriority;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class JobProgressDto {
  @ApiProperty({ description: 'Current step' })
  @IsNumber()
  step: number;

  @ApiProperty({ description: 'Total steps' })
  @IsNumber()
  totalSteps: number;

  @ApiPropertyOptional({ description: 'Progress message' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class BulkJobDto {
  @ApiProperty({ description: 'Jobs to create', type: [CreateJobDto] })
  @IsArray()
  jobs: CreateJobDto[];
}

export class RetryJobDto {
  @ApiPropertyOptional({ description: 'Delay before retry in milliseconds' })
  @IsOptional()
  @IsNumber()
  delay?: number;
}

