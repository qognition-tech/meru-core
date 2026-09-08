import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertFeatureFlagDto {
  @ApiPropertyOptional({
    description: 'Flag value — any JSON (boolean, string, object)',
    example: true,
  })
  @IsOptional()
  value?: unknown;

  @ApiPropertyOptional({ example: 'Enables the new kanban board' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  rolloutPercentage?: number;

  @ApiPropertyOptional({ type: [String], example: ['firm_admin', 'staff'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetRoles?: string[];
}
