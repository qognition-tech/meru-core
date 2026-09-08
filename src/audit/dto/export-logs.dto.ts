import { IsDateString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for `POST /audit/logs/export`.
 *
 * Was an inline type literal, so an empty body produced `new Date(undefined)`
 * and Postgres rejected the resulting `Invalid Date` with
 * `invalid input syntax for type timestamp: "0NaN-NaN-NaN…"` — a 500 for a bad
 * request, on the endpoint regulators are meant to pull evidence from.
 */
export class ExportLogsDto {
  @ApiProperty({ example: '2026-01-01' })
  @IsDateString({}, { message: 'startDate must be an ISO 8601 date' })
  startDate: string;

  @ApiProperty({ example: '2026-12-31' })
  @IsDateString({}, { message: 'endDate must be an ISO 8601 date' })
  endDate: string;

  @ApiProperty({ enum: ['json', 'csv', 'xml'] })
  @IsEnum(['json', 'csv', 'xml'] as any, {
    message: 'format must be one of: json, csv, xml',
  })
  format: 'json' | 'csv' | 'xml';
}
