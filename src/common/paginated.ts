import { PaginationMeta } from './types';

/**
 * Marker a handler returns when its payload is a page of results.
 *
 * `ResponseEnvelopeInterceptor` recognises this and unpacks it into the
 * documented envelope — `data` becomes the array itself and the counts move to
 * `meta.pagination` — so list endpoints stay `data: [...]` for clients while
 * still reporting totals. Without it, the only way to return a total was to
 * bury it in the payload, where every caller had to know it was there.
 */
export const PAGINATED = Symbol('meru.paginated');

export interface Paginated<T> {
  readonly [PAGINATED]: true;
  items: T[];
  pagination: PaginationMeta;
}

export function isPaginated(value: unknown): value is Paginated<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    PAGINATED in (value as object)
  );
}

/**
 * Build a page of results.
 *
 * `page` and `limit` are the *effective* values the query ran with, not the raw
 * request params — a caller that omitted them still gets accurate numbers back.
 */
export function paginated<T>(
  items: T[],
  total: number,
  page = 1,
  limit = items.length || 20,
): Paginated<T> {
  const pageSize = limit > 0 ? limit : 20;
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;

  const pagination: PaginationMeta = {
    page,
    pageSize,
    totalItems: total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };

  return { [PAGINATED]: true, items, pagination };
}
