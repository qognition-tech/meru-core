import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTagDto {
  @ApiProperty({ description: 'Tag name', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Hex color code',
    example: '#6366f1',
    maxLength: 7,
  })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'color must be a valid hex color (e.g. #6366f1)',
  })
  color?: string;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ description: 'Tag name', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Hex color code',
    example: '#6366f1',
    maxLength: 7,
  })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'color must be a valid hex color (e.g. #6366f1)',
  })
  color?: string;
}