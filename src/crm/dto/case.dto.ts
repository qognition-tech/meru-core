import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsObject,
  IsDateString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CaseStatus, CasePriority } from '../entities/case.entity';

export class CreateCaseDto {
  @ApiProperty({ description: 'Case title', maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  title: string;

  @ApiPropertyOptional({ description: 'Case description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Case type', example: 'visa_application', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  caseType: string;

  @ApiPropertyOptional({ enum: CasePriority, default: CasePriority.MEDIUM })
  @IsOptional()
  @IsEnum(CasePriority)
  priority?: CasePriority;

  @ApiPropertyOptional({ description: 'Assigned user UUID' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Vertical-specific case data' })
  @IsOptional()
  @IsObject()
  caseData?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateCaseDto {
  @ApiPropertyOptional({ description: 'Case title', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: 'Case description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Case type', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  caseType?: string;

  @ApiPropertyOptional({ enum: CasePriority })
  @IsOptional()
  @IsEnum(CasePriority)
  priority?: CasePriority;

  @ApiPropertyOptional({ description: 'Assigned user UUID' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Vertical-specific case data (merged)' })
  @IsOptional()
  @IsObject()
  caseData?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Additional metadata (merged)' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class TransitionCaseDto {
  @ApiProperty({ enum: CaseStatus, description: 'Target status' })
  @IsEnum(CaseStatus)
  targetStatus: CaseStatus;

  @ApiPropertyOptional({ description: 'Transition comment' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CaseFilterDto {
  @ApiPropertyOptional({ enum: CaseStatus })
  @IsOptional()
  @IsEnum(CaseStatus)
  status?: CaseStatus;

  @ApiPropertyOptional({ enum: CasePriority })
  @IsOptional()
  @IsEnum(CasePriority)
  priority?: CasePriority;

  @ApiPropertyOptional({ description: 'Filter by assigned user UUID' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Filter by case type' })
  @IsOptional()
  @IsString()
  caseType?: string;

  @ApiPropertyOptional({ description: 'Free-text search across title and description' })
  @IsOptional()
  @IsString()
  search?: string;
}