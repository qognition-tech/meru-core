import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for the regulator sanctions-screening endpoints.
 *
 * A real class, not an inline type literal. As a literal there was no metatype
 * for `ValidationPipe` to reflect on, so nothing validated: a caller sending
 * `{ name, entityType }` screened `undefined` and got **HTTP 200 with junk**
 * back — the worst failure mode available, since it looks like a clean result.
 * With `forbidNonWhitelisted` this now 400s on the wrong field name.
 */
export class ScreenEntityDto {
  @ApiProperty({
    example: 'Acme Trading LLC',
    description: 'Legal name of the person or organisation to screen.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  entityName: string;

  @ApiPropertyOptional({ example: 'AE' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nationality?: string;

  @ApiPropertyOptional({ example: '784-1990-1234567-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idNumber?: string;
}
