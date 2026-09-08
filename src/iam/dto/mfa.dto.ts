import { IsJWT, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Confirms a TOTP enrolment for the currently authenticated user. */
export class VerifyMfaSetupDto {
  @ApiProperty({ example: '123456', description: 'Six-digit TOTP code' })
  @IsString()
  @Length(6, 6, { message: 'token must be a six-digit code' })
  token: string;
}

/** Completes the second leg of an MFA login. */
export class VerifyMfaLoginDto {
  @ApiProperty({
    description:
      'The `temporaryToken` returned by POST /auth/login when it responded ' +
      'with `requiresMfa: true`. Valid for 5 minutes and good only for this ' +
      'exchange — it carries no authority of its own.',
  })
  @IsJWT()
  temporaryToken: string;

  @ApiProperty({ example: '123456', description: 'Six-digit TOTP code' })
  @IsString()
  @Length(6, 6, { message: 'token must be a six-digit code' })
  token: string;
}
