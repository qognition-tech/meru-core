import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /crm/entities/:id/acceptance`.
 *
 * No `userId`, `email`, `ip` or `acceptedAt`: every one of those is taken from
 * the request. A caller-supplied "user X accepted at time Y from address Z" is
 * an assertion, not evidence, and the whole point of this record is to be the
 * latter.
 */
export class RecordAcceptanceDto {
  @ApiProperty({
    description:
      'What was accepted — a document template key, or a named set of terms.',
    example: 'cost_agreement',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject: string;

  @ApiPropertyOptional({
    description:
      'SHA-256 (64 hex chars) of the exact document bytes the person was shown. ' +
      '**Supply this.** Without it the record shows that somebody clicked ' +
      'something, not what they agreed to, and the wording can be changed ' +
      'afterwards with nothing to detect it.',
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message:
      'documentSha256 must be 64 hexadecimal characters (a SHA-256 digest)',
  })
  documentSha256?: string;
}
