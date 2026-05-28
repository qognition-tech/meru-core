import {
  IsString,
  IsOptional,
  IsBoolean,
  IsUUID,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNoteDto {
  @ApiProperty({ description: 'Entity type', example: 'case', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  entityType: string;

  @ApiProperty({ description: 'Entity UUID' })
  @IsUUID()
  entityId: string;

  @ApiProperty({ description: 'Note content' })
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ description: 'Internal note flag', default: false })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class UpdateNoteDto {
  @ApiPropertyOptional({ description: 'Note content' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  content?: string;

  @ApiPropertyOptional({ description: 'Internal note flag' })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class NoteFilterDto {
  @ApiPropertyOptional({ description: 'Filter by entity type' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({ description: 'Filter internal/non-internal notes' })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @ApiPropertyOptional({ description: 'Free-text search' })
  @IsOptional()
  @IsString()
  search?: string;
}