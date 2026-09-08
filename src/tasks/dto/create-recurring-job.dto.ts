import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /tasks/recurring-jobs`.
 *
 * Was untyped, so a body without `name` reached the insert and 500'd on the
 * NOT NULL constraint. `schedule` is validated as a five- or six-field cron
 * expression rather than accepted as free text — an unparseable schedule
 * creates a job that silently never fires, which is worse than a rejection.
 */
export class CreateRecurringJobDto {
  @ApiProperty({ example: 'Monthly compliance review' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    example: '0 9 1 * *',
    description: 'Cron expression, 5 or 6 fields.',
  })
  @IsString()
  @Matches(/^(\S+\s+){4,5}\S+$/, {
    message:
      'schedule must be a cron expression of 5 or 6 space-separated fields',
  })
  schedule: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Template the generated task is built from.',
  })
  @IsObject()
  taskTemplate: Record<string, any>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
