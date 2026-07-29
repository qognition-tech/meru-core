import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority, TaskStatus, TaskType } from '../entities/task.entity';

/**
 * Query for `GET /tasks`.
 *
 * A DTO rather than a handful of loose `@Query('x')` params, because with
 * individual params the global ValidationPipe has nothing to whitelist against
 * and unknown keys are silently discarded. `?view=calendar` was being ignored
 * and the endpoint cheerfully returned every task in the tenant with a 200 —
 * wrong data, no error. `forbidNonWhitelisted` now turns that into a 400.
 */
export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({ enum: TaskType })
  @IsOptional()
  @IsEnum(TaskType)
  type?: TaskType;
}

/**
 * Query for `GET /tasks/calendar/events`.
 *
 * Both dates are required and validated. They used to be untyped strings fed
 * straight into `new Date(...)`; with no query string at all that produced
 * `Invalid Date`, which Postgres rejected as
 * `invalid input syntax for type timestamp: "0NaN-NaN-NaNTNaN:N…"` — a 500 for
 * what is plainly a bad request.
 */
export class CalendarEventsQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    description: 'ISO 8601 date or datetime',
  })
  @IsDateString(
    {},
    { message: 'startDate must be an ISO 8601 date, e.g. 2026-07-01' },
  )
  startDate: string;

  @ApiProperty({
    example: '2026-08-31',
    description: 'ISO 8601 date or datetime',
  })
  @IsDateString(
    {},
    { message: 'endDate must be an ISO 8601 date, e.g. 2026-08-31' },
  )
  endDate: string;
}
