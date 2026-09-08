import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query for `GET /analytics/trends/:kpiKey`.
 *
 * A DTO rather than loose `@Query` params for the reason `ListTasksQueryDto`
 * documents: with individual params the global ValidationPipe has nothing to
 * whitelist against, so a typo'd `?intervel=day` is silently ignored and the
 * caller gets monthly buckets while believing they asked for daily.
 */
export class TrendQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'month' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month';

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO 8601 date, e.g. 2026-01-01' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO 8601 date, e.g. 2026-08-31' })
  to?: string;

  @ApiPropertyOptional({
    example: 'createdAt',
    description: 'Top-level column or verticalAttributes key.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dateField?: string;
}
