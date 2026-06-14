import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AiResponse } from '../ai.service';

const CITATION_FALLBACK_MESSAGE =
  "I don't have a verified source for this. Please consult the relevant government regulator directly.";

// CLAUDE.md §6.3 enforcement.
// Applied at the AI controller level. Every AiResponse that reaches the wire
// must have at least one source citation. If sources is empty, the result is
// replaced with the fallback message and citationEnforced is set to false.
//
// The interceptor only acts when the response body contains an AiResponse
// (has a 'sources' field). Other response shapes are passed through.
@Injectable()
export class CitationEnforcementInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CitationEnforcementInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((response: unknown) => {
        return this.enforceOnBody(response);
      }),
    );
  }

  private enforceOnBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;

    // Handle envelope: { data: AiResponse, ... }
    const envelope = body as Record<string, unknown>;
    if ('data' in envelope && this.isAiResponse(envelope['data'])) {
      return {
        ...envelope,
        data: this.enforce(envelope['data']),
      };
    }

    // Handle bare AiResponse
    if (this.isAiResponse(body)) {
      return this.enforce(body);
    }

    return body;
  }

  private isAiResponse(val: unknown): val is AiResponse {
    return (
      val !== null &&
      typeof val === 'object' &&
      'sources' in val &&
      'result' in val
    );
  }

  private enforce(response: AiResponse): AiResponse {
    if (response.sources && response.sources.length > 0) {
      return { ...response, citationEnforced: true };
    }

    this.logger.warn(
      `AI response suppressed — no citations provided. Model: ${response.model}`,
    );

    return {
      ...response,
      result: CITATION_FALLBACK_MESSAGE,
      sources: [],
      citationEnforced: false,
    };
  }
}
