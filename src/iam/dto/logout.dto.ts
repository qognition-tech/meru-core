import { IsString, IsNotEmpty } from 'class-validator';

export class LogoutDto {
  @IsString()
  @IsNotEmpty({ message: 'refresh_token is required' })
  refresh_token: string; // Identifies the single session to revoke
}
