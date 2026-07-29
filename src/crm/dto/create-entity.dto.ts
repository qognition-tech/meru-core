import {
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus, EntityType } from '../entities/universal-entity.entity';
import { CreateEntityInput } from '../../common/types';

export class CreateEntityDto implements CreateEntityInput {
  @ApiProperty({
    enum: EntityType,
    description: 'Type of the entity',
    example: EntityType.PERSON,
  })
  @IsEnum(EntityType)
  type: EntityType;

  @ApiPropertyOptional({
    description: 'First name of the entity',
    example: 'John',
  })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({
    description: 'Last name of the entity',
    example: 'Doe',
  })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    description: 'Email address',
    example: 'john.doe@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'Phone number',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Vertical-specific attributes',
    type: 'object',
    additionalProperties: true,
    example: { customField: 'value' },
  })
  @IsOptional()
  verticalAttributes?: Record<string, any>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // Meaningful for workable types (case, obligation, breach). Omitting
  // `status` starts those at `open` and leaves reference types null.

  @ApiPropertyOptional({
    enum: EntityStatus,
    description:
      'Generic lifecycle state. Verticals map their own vocabulary onto these ' +
      'in a config pack rather than core learning GRC or immigration stages.',
  })
  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;

  @ApiPropertyOptional({ example: '2026-09-30T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'users.id of the owner' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}
