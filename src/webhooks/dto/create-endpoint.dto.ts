import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateInboundEndpointDto {
  @ApiProperty({ example: 'Cal.com bookings' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: 'calcom',
    description: 'Hint only; not interpreted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  provider?: string;

  @ApiPropertyOptional({
    enum: ['hmac-sha256-hex', 'hmac-sha256-base64', 'bearer-token', 'none'],
    default: 'hmac-sha256-hex',
  })
  @IsOptional()
  @IsIn(['hmac-sha256-hex', 'hmac-sha256-base64', 'bearer-token', 'none'])
  signatureScheme?: 'hmac-sha256-hex' | 'hmac-sha256-base64' | 'bearer-token' | 'none';

  @ApiPropertyOptional({
    description:
      'Header carrying the signature or token. Defaults: `x-meru-signature` for HMAC schemes, `authorization` for bearer',
    example: 'x-cal-signature-256',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/i)
  signatureHeader?: string;

  @ApiPropertyOptional({
    description:
      "Supply the sender's own secret when the provider issues one (Cal.com, Dropbox Sign). Omit and Meru generates one to paste into the sender.",
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Dot path to the event type in the body, e.g. `triggerEvent`, `event.type`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9_.]+$/)
  eventTypePath?: string;
}
