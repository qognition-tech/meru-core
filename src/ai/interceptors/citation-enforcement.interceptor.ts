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

// CLAUDE.md §5.3 enforcement — citations or silence.
// Applied on every controller whose routes can carry LLM output: /ai, /engines,
// /documents and /orchestration. It used to sit on /ai alone, which meant a
// route elsewhere that returned the same AiResponse shape reached the wire
// unenforced. Every AiResponse that reaches the wire must have at least one
// source citation. If sources is empty, the result is replaced with the
// fallback message and citationEnforced is set to false.
//
// The interceptor acts on any AiResponse-shaped value (`result` + `sources`)
// it finds — at the top level, under a `data` envelope, or nested inside an
// object or array to a bounded depth. Anything else passes through untouched,
// which is why a screening result, a vessel position or a scoring band is not
// affected by it: those are computed, not generated, and carry no prose.
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
    return this.walk(body, 0);
  }

  // Bounded so a pathological body cannot turn a response into a deep scan.
  // Three levels covers { data: { results: [ { aiInsights: AiResponse } ] } },
  // which is the deepest shape any route here produces.
  private static readonly MAX_DEPTH = 4;

  private walk(value: unknown, depth: number): unknown {
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;

    if (this.isAiResponse(value)) return this.enforce(value);
    if (depth >= CitationEnforcementInterceptor.MAX_DEPTH) return value;

    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v) => {
        const w = this.walk(v, depth + 1);
        if (w !== v) changed = true;
        return w;
      });
      return changed ? out : value;
    }

    const record = value as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const w = this.walk(record[key], depth + 1);
      if (w !== record[key]) changed = true;
      out[key] = w;
    }
    // Return the original object when nothing inside it was an AiResponse so
    // class instances (entities) are not flattened into plain objects.
    return changed ? out : value;
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
