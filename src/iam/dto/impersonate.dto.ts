import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A reason is required, not optional.
 *
 * The audit entry for an impersonation is the only record of why a platform
 * operator read a customer's data. "Impersonated tenant X" answers nothing
 * six months later when a regulator asks; the field exists so the answer is
 * captured while the operator still knows it. MinLength stops a reflexive "-".
 */
export class ImpersonateDto {
  @ApiProperty({
    description: 'Why this support session is being opened. Written to the audit log.',
    example: 'Ticket MER-4821 — firm reports case detail returns 500',
    minLength: 10,
    maxLength: 300,
  })
  @IsString()
  @MinLength(10, {
    message:
      'reason must be at least 10 characters — it is the audit record for ' +
      'reading a customer tenant',
  })
  @MaxLength(300)
  reason: string;
}
