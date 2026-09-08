import { IsDateString, IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
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

  @ApiPropertyOptional({ format: 'uuid', description: 'Tasks about one record' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    description: 'Only tasks due before this instant.',
    example: '2026-09-30',
  })
  @IsOptional()
  @IsDateString()
  dueBefore?: string;

  @ApiPropertyOptional({
    description: 'Only tasks due on or after this instant.',
    example: '2026-07-01',
  })
  @IsOptional()
  @IsDateString()
  dueAfter?: string;

  // `?limit` used to be a 400 — `forbidNonWhitelisted` rejected it because the
  // DTO did not declare it, so `GET /tasks` had no pagination of any kind and
  // returned every task in the tenant. Same names, defaults and ceiling as
  // `GET /crm/entities`: three list endpoints with three different contracts is
  // the complaint this closes, so matching matters more than the values.
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({
    default: 50,
    description: 'Clamped to 200, as on /crm/entities.',
  })
  @IsOptional()
  limit?: number;
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

  @ApiPropertyOptional({
    enum: ['mine', 'firm'],
    default: 'mine',
    description:
      "Whose tasks to return. `mine` is the caller's own; `firm` is every " +
      'task in the tenant, which is what a shared team calendar needs. The ' +
      'endpoint was hard-scoped to the caller with no way to widen it, so a ' +
      'firm-wide month view could not be built from it at all.',
  })
  @IsOptional()
  @IsIn(['mine', 'firm'])
  scope?: 'mine' | 'firm';
}
