import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CitationEnforcementInterceptor } from './citation-enforcement.interceptor';

/**
 * Citations or silence (CLAUDE.md §5.3) is only a rule if it holds on every
 * route that can carry model output. The interceptor used to sit on /ai alone
 * and only looked at the top level and `data`; an AiResponse nested inside a
 * search result or an insights object reached the wire unsourced.
 */
describe('CitationEnforcementInterceptor', () => {
  const interceptor = new CitationEnforcementInterceptor();
  const ctx = {} as ExecutionContext;
  const run = (body: unknown) =>
    lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of(body) } as CallHandler),
    );

  const uncited = { result: 'You need form 47SP.', model: 'm', sources: [] };
  const cited = {
    result: 'You need form 47SP.',
    model: 'm',
    sources: [{ title: 'Home Affairs', url: 'https://immi.homeaffairs.gov.au' }],
  };

  it('suppresses an unsourced top-level response', async () => {
    const out = (await run(uncited)) as Record<string, unknown>;
    expect(out.citationEnforced).toBe(false);
    expect(out.result).not.toBe(uncited.result);
  });

  it('stamps a sourced response', async () => {
    const out = (await run(cited)) as Record<string, unknown>;
    expect(out.citationEnforced).toBe(true);
    expect(out.result).toBe(cited.result);
  });

  it('reaches an AiResponse nested in a search result', async () => {
    const body = {
      results: [{ id: 'e1', aiInsights: { parsed: null, ai: uncited } }],
      method: 'semantic',
    };
    const out = (await run(body)) as any;
    expect(out.results[0].aiInsights.ai.citationEnforced).toBe(false);
    expect(out.results[0].aiInsights.ai.result).not.toBe(uncited.result);
    expect(out.method).toBe('semantic');
  });

  it('reaches an AiResponse riding on an insights object', async () => {
    const out = (await run({ riskLevel: null, ai: uncited })) as any;
    expect(out.ai.citationEnforced).toBe(false);
  });

  it('passes a computed result through untouched, by identity', async () => {
    // A screening result has hits, not prose. Nothing here is an AiResponse,
    // so the very same object comes back — entities are not flattened.
    const screening = { status: 'clear', hits: [], listsLoaded: true, completedAt: new Date() };
    expect(await run(screening)).toBe(screening);
  });
});
