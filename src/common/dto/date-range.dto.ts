import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A required reporting window.
 *
 * Shared because the same bug kept recurring: handlers took loose
 * `@Query('startDate') startDate: string` params and fed them straight into
 * `new Date(...)`. With the params absent that produces `Invalid Date`, which
 * Postgres rejects as
 * `invalid input syntax for type timestamp: "0NaN-NaN-NaNTNaN:NaN:NaN"` — a 500
 * for what is plainly a bad request, on `/tasks/calendar/events`,
 * `/audit/logs/user/:id`, `/audit/compliance/:standard` and `/billing/metrics`
 * alike. A DTO turns all of them into a 400.
 */
export class DateRangeQueryDto {
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
    example: '2026-09-30',
    description: 'ISO 8601 date or datetime',
  })
  @IsDateString(
    {},
    { message: 'endDate must be an ISO 8601 date, e.g. 2026-09-30' },
  )
  endDate: string;
}
