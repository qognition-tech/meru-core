import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID } from 'class-validator';

export class PreviewTemplateDto {
  @ApiPropertyOptional({
    description:
      'Render against this CRM record, using exactly the variables a sequence step would supply',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    type: Object,
    description: 'Extra or overriding variables; applied after the record-derived ones',
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;
}
