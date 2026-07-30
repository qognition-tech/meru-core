import { ArrayMaxSize, IsArray, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for `POST /search/index/entity`.
 *
 * Was an inline type literal `{ entity: any }`, which is erased at runtime —
 * so a body without `entity` reached the indexer and threw
 * `Cannot read properties of undefined (reading 'id')`, a 500 for a malformed
 * request.
 */
export class IndexEntityDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  entity: Record<string, any>;
}

/** Body for `POST /search/index/bulk`. */
export class BulkIndexDto {
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  // Bounded: an unbounded bulk index is an easy way to exhaust the event loop
  // and the Elasticsearch bulk queue in one request.
  @ArrayMaxSize(10000)
  @IsObject({ each: true })
  entities: Array<Record<string, any>>;
}
