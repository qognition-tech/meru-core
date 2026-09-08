import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * An AIS feed batch: raw NMEA sentences, already-decoded positions, or both.
 *
 * Batched rather than one-at-a-time because a busy receiver emits thousands of
 * sentences a minute, and because multi-part messages only decode when their
 * fragments arrive together.
 */
export class AisIngestDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['!AIVDM,1,1,,A,15MvlfPOh2G?nwbEdVDsnSTR00S?,0*41'],
    description: 'Raw AIVDM/AIVDO sentences, in receipt order.',
  })
  @IsOptional()
  @IsArray()
  // Bounded so one request cannot pin the event loop decoding indefinitely.
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  sentences?: string[];

  @ApiPropertyOptional({
    type: [Object],
    description:
      'Pre-decoded positions, the shape most aggregators emit. Requires ' +
      '`mmsi` on each entry; other fields are merged when present.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  positions?: Array<Record<string, any> & { mmsi: string }>;
}
