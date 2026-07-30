import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataSource, ReportType } from '../entities/report.entity';
import { WidgetType } from '../entities/dashboard-widget.entity';

/**
 * Body for `POST /analytics/reports`.
 *
 * Was `@Body() dto: any`, so a body without `name` reached the insert and
 * returned `null value in column "name" of relation "reports" violates
 * not-null constraint` — a 500 that also leaks the table and column names.
 */
export class CreateReportDto {
  @ApiProperty({ example: 'Monthly case throughput' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: ReportType })
  @IsEnum(ReportType)
  reportType: ReportType;

  @ApiProperty({ enum: DataSource })
  @IsEnum(DataSource)
  dataSource: DataSource;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  configuration: Record<string, any>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  schedule?: Record<string, any>;
}

/** Body for `POST /analytics/widgets`. */
export class CreateWidgetDto {
  @ApiProperty({ example: 'Open cases' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: WidgetType })
  @IsEnum(WidgetType)
  widgetType: WidgetType;

  @ApiPropertyOptional({ enum: DataSource })
  @IsOptional()
  @IsEnum(DataSource)
  dataSource?: DataSource;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  position?: Record<string, any>;
}

/** Body for `POST /analytics/reports/:id/execute`. */
export class ExecuteReportBodyDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, any>;

  @ApiPropertyOptional({ enum: ['json', 'csv', 'xlsx', 'pdf'] })
  @IsOptional()
  @IsEnum(['json', 'csv', 'xlsx', 'pdf'] as any)
  format?: 'json' | 'csv' | 'xlsx' | 'pdf';
}
