import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { ApiResponse, ApiMeta } from '../../common/types';

/**
 * Wraps all successful responses in the Meru API Response Envelope:
 * { data, meta: { requestId, timestamp, version, pagination? }, error: null }
 *
 * Skips wrapping if the response is already an ApiResponse (e.g., from error filter).
 * Skips wrapping for raw streams/buffers.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    return next.handle().pipe(
      map((data) => {
        // Don't double-wrap if already an ApiResponse
        if (
          data &&
          typeof data === 'object' &&
          'meta' in data &&
          'error' in data &&
          'data' in data
        ) {
          return data;
        }

        // Don't wrap raw buffers, streams, or file responses
        if (Buffer.isBuffer(data) || data?.pipe || response.headersSent) {
          return data;
        }

        const requestId =
          (request.headers['x-request-id'] as string) || uuidv4();
        const meta: ApiMeta = {
          requestId,
          timestamp: new Date().toISOString(),
          version: 'v1',
        };

        // Attach pagination if present in data
        if (data && typeof data === 'object' && 'pagination' in data) {
          meta.pagination = data.pagination;
          // Remove pagination from data payload
          const { pagination, ...payload } = data;
          data = payload;
        }

        const envelope: ApiResponse = {
          data: data ?? null,
          meta,
          error: null,
        };

        return envelope;
      }),
    );
  }
}
