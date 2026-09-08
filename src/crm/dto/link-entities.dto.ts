import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';

/** Body of `POST /crm/entities/:id/relations`. */
export class LinkEntitiesDto {
  @ApiProperty({
    description:
      "A `relationships[].key` from the vertical's config pack. Validated " +
      'against the pack rather than accepted as free text, which is what the ' +
      'jsonb array it replaces did.',
    example: 'blocks',
  })
  @IsString()
  @MaxLength(100)
  relationKey: string;

  @ApiProperty({
    description: 'The entity this one points at.',
    format: 'uuid',
  })
  @IsUUID()
  toId: string;
}
