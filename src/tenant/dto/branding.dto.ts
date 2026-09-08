import { IsBoolean, IsHexColor, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Tenant branding — applied by the vertical apps as CSS variables at runtime.
 * Deliberately small: logo, two colours, and the display essentials. Custom
 * domains are NOT here; they need DNS + TLS provisioning, not a settings row.
 */
export class BrandingDto {
  @ApiPropertyOptional({ example: 'https://cdn.example.com/logo.svg' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/favicon.png' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  faviconUrl?: string;

  @ApiPropertyOptional({ example: '#1A2B4A' })
  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @ApiPropertyOptional({ example: '#0D8A8A' })
  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @ApiPropertyOptional({ example: 'Acme Immigration' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ example: 'Asia/Dubai' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Set true when the first-login onboarding wizard completes',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  onboardingComplete?: boolean;
}
