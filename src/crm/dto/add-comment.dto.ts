import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class AddCommentDto {
  @ApiProperty({
    description: 'The comment text',
    example: 'Client confirmed the sponsor letter is on the way.',
  })
  @IsString()
  @MinLength(1)
  body: string;

  @ApiPropertyOptional({
    description:
      'Internal-only. Never returned to a client portal caller unless ' +
      '`includeInternal` is explicitly requested.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  internal?: boolean;
}
