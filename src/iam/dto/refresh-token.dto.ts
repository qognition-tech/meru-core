import { IsString, IsNotEmpty } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'refresh_token is required' })
  refresh_token: string; // Opaque token issued by POST /auth/login
}
