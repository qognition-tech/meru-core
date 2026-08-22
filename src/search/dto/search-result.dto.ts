import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SearchableType } from '../entities/search-index.entity';

/**
 * One hit from `GET /search`. The shape is identical whether the hit came from
 * Elasticsearch or the Postgres ILIKE fallback — a consumer cannot tell and
 * must not need to.
 */
export class SearchResultDto {
  @ApiProperty({ description: 'search_index row id (not the record id)' })
  id!: string;

  @ApiProperty({ enum: SearchableType })
  type!: SearchableType;

  @ApiProperty({
    description:
      'The id of the indexed record: a /crm/entities id for `entity`, a /documents id for `document`',
  })
  searchableId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Excerpt around the match; may be empty' })
  snippet!: string;

  @ApiPropertyOptional({ type: Object, nullable: true })
  metadata?: Record<string, unknown> | null;

  @ApiProperty({
    description:
      'Relevance. Elasticsearch `_score` or a heuristic title/content score — comparable only within one response',
  })
  score!: number;
}

export class SearchResponseDto {
  @ApiProperty({ type: [SearchResultDto] })
  results!: SearchResultDto[];

  @ApiProperty({
    description:
      'Number of results returned — bounded by `limit`, so it is not a total across the index',
  })
  total!: number;
}
