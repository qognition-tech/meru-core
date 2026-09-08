import { IsBoolean, IsEnum, IsObject, IsOptional, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConnectorMode } from '../entities/tenant-connector.entity';

export class UpsertConnectorDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ConnectorMode, example: ConnectorMode.SANDBOX })
  @IsOptional()
  @IsEnum(ConnectorMode)
  mode?: ConnectorMode;

  @ApiPropertyOptional({
    description:
      'Adapter credentials (client id/secret, certs). Encrypted at rest; ' +
      'never returned by the API. Send null to clear.',
    example: { clientId: '…', clientSecret: '…' },
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o) => o.credentials !== null)
  @IsObject()
  credentials?: Record<string, unknown> | null;
}
