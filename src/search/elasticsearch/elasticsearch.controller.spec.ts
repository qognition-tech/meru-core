import { ServiceUnavailableException } from '@nestjs/common';
import { ElasticsearchController } from './elasticsearch.controller';
import { ElasticsearchService } from './elasticsearch.service';

/**
 * `POST /search/semantic` used to run the similarity search anyway against
 * `embedding: []` — a zero-length vector cosine-similarity cannot score
 * against anything — and answer 200 with ranked-looking results built from
 * nothing. That is exactly the "unknown rendered as an answer" CLAUDE.md
 * §7.3 forbids: a caller has no way to distinguish "nothing matched" from
 * "this route cannot answer at all".
 *
 * This route is class-gated to `platform_admin` (`@Roles`), enforced by
 * `PolicyGuard` — a Nest guard, not exercised by constructing the controller
 * directly. This spec proves the *handler* never fabricates a 200; it does
 * not prove the role gate is wired, which is a guard/module-graph concern
 * these unit tests cannot see (see the caveat in `crm-authz.spec.ts`).
 */
describe('ElasticsearchController.semanticSearch', () => {
  const es = {
    search: jest.fn(),
  };

  const controller = () => new ElasticsearchController(es as unknown as ElasticsearchService);

  it('never returns 200 — it always throws a 503', async () => {
    const c = controller();
    await expect(c.semanticSearch({ query: 'visa renewal' } as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('the 503 carries unavailableReason, not a fabricated empty result set', async () => {
    const c = controller();
    try {
      await c.semanticSearch({ query: 'visa renewal' } as any);
      throw new Error('expected semanticSearch to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const response = (err as ServiceUnavailableException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.unavailableReason).toBe('embedding_pipeline_not_configured');
      expect(response.code).toBe('MER-SRV-0503');
    }
  });

  it('never calls into the search engine at all — no zero-vector similarity query', async () => {
    const c = controller();
    await expect(c.semanticSearch({ query: 'anything' } as any)).rejects.toBeDefined();
    expect(es.search).not.toHaveBeenCalled();
  });

  it('echoes the query back for the caller to retry against keyword search, not silently drops it', async () => {
    const c = controller();
    try {
      await c.semanticSearch({ query: 'medical exam requirements' } as any);
      throw new Error('expected semanticSearch to throw');
    } catch (err) {
      const response = (err as ServiceUnavailableException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.query).toBe('medical exam requirements');
    }
  });
});
