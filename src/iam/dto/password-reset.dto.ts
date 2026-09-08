import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'layla@acme-bank.ae' })
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'The single-use token from the reset or invite email. Valid for 60 ' +
      'minutes (reset) or 7 days (invite), and dies on first use.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @ApiProperty({ minLength: 8, example: 'a-strong-new-password' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
