import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SearchIndex, SearchableType } from './entities/search-index.entity';
import { ElasticsearchService } from './elasticsearch/elasticsearch.service';

describe('SearchService', () => {
  const repo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (x: unknown) => x),
    delete: jest.fn(),
  };
  const es = {
    available: false,
    search: jest.fn(),
    indexDocument: jest.fn(),
    deleteDocument: jest.fn(),
  };
  let service: SearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    es.available = false;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getRepositoryToken(SearchIndex), useValue: repo },
        { provide: ElasticsearchService, useValue: es },
      ],
    }).compile();
    service = moduleRef.get(SearchService);
  });

  it('answers from Postgres when Elasticsearch is not connected', async () => {
    repo.find.mockResolvedValue([
      {
        id: 'r1',
        searchableType: SearchableType.ENTITY,
        searchableId: 'e1',
        title: 'John Smith',
        content: 'john smith',
        metadata: {},
      },
    ]);
    const out = await service.search('t1', 'john');
    expect(es.search).not.toHaveBeenCalled();
    expect(out[0].searchableId).toBe('e1');
  });

  it('delegates to Elasticsearch when connected, with the same result shape', async () => {
    es.available = true;
    es.search.mockResolvedValue({
      total: 1,
      took: 3,
      documents: [
        { id: 'e1', type: 'entity', title: 'John Smith', content: 'x', metadata: { a: 1 }, score: 4.2 },
      ],
      highlights: [{ content: ['<mark>John</mark>'] }],
    });
    const out = await service.search('t1', 'john', 5);
    expect(repo.find).not.toHaveBeenCalled();
    expect(es.search).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ query: 'john', pagination: { size: 5 } }),
    );
    expect(out).toEqual([
      {
        id: 'e1',
        type: 'entity',
        searchableId: 'e1',
        title: 'John Smith',
        snippet: '<mark>John</mark>',
        metadata: { a: 1 },
        score: 4.2,
      },
    ]);
  });

  it('falls back to Postgres when the Elasticsearch query throws', async () => {
    es.available = true;
    es.search.mockRejectedValue(new Error('cluster gone'));
    repo.find.mockResolvedValue([]);
    await expect(service.search('t1', 'john')).resolves.toEqual([]);
    expect(repo.find).toHaveBeenCalled();
  });

  it('always writes Postgres, and mirrors to Elasticsearch only when connected', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.indexEntityData({ id: 'e1', tenantId: 't1', firstName: 'A', type: 'person' });
    expect(repo.save).toHaveBeenCalled();
    expect(es.indexDocument).not.toHaveBeenCalled();

    es.available = true;
    await service.indexEntityData({ id: 'e2', tenantId: 't1', firstName: 'B', type: 'person' });
    expect(es.indexDocument).toHaveBeenCalledWith(
      't1',
      'entities',
      expect.objectContaining({ id: 'e2', title: 'B' }),
    );
  });

  it('does not lose the Postgres write when the mirror fails', async () => {
    es.available = true;
    es.indexDocument.mockRejectedValue(new Error('boom'));
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.indexEntityData({ id: 'e3', tenantId: 't1', email: 'x@y' }),
    ).resolves.toBeDefined();
  });

  /**
   * `POST /search/index/entity` used to trust the request body's
   * `entity.tenantId` outright — a cross-tenant overwrite primitive, since the
   * dedup lookup below matched on `searchableId` alone with no `tenantId` in
   * the `WHERE`. The controller now always passes the authenticated caller's
   * own `tenantId` as `overrideTenantId`; these tests pin the service side of
   * that fix independent of the controller, the way the class doc says a
   * "trusted from the request body" bug must never come back.
   */
  describe('tenant derivation — the authenticated caller, never the payload', () => {
    it('writes the caller-derived tenantId, ignoring a hostile tenantId in the entity payload', async () => {
      repo.findOne.mockResolvedValue(null);

      const hostilePayload = {
        id: 'e1',
        // A `client` token for tenant "attacker" naming a victim tenant.
        tenantId: 'victim-tenant',
        firstName: 'Evil',
        type: 'person',
      };

      await service.indexEntityData(hostilePayload, 'attacker-tenant');

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'attacker-tenant' }),
      );
      // Never the value the caller supplied in the body.
      expect(repo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'victim-tenant' }),
      );
    });

    it('falls back to entity.tenantId only for internal callers that pass no override', async () => {
      // CRM, tasks, workflow, documents and forms call this with their own
      // already-tenant-scoped entity and never pass a second argument — this
      // is the "everything keeps working unchanged" half of the fix, not a
      // second way for a client-controlled value to win.
      repo.findOne.mockResolvedValue(null);
      await service.indexEntityData({ id: 'e9', tenantId: 'internal-t1', type: 'task' });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'internal-t1' }),
      );
    });

    it('scopes the dedup lookup by tenantId, not searchableId alone', async () => {
      // Without `tenantId` in the WHERE, indexing entity "e1" under tenant B
      // would find and overwrite tenant A's existing "e1" row.
      repo.findOne.mockResolvedValue(null);
      await service.indexEntityData({ id: 'e1', type: 'person' }, 'attacker-tenant');

      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'attacker-tenant',
            searchableId: 'e1',
          }),
        }),
      );
    });
  });

  /**
   * `GET /search` used to hand a `client` token titles and snippets of every
   * record in the tenant. `scopeResults` is the fix: an `own`-scope caller's
   * results are filtered to what `indexEntityData` tagged as theirs.
   */
  describe('actor scoping on search results', () => {
    const rows = () => [
      {
        id: 'r1',
        searchableType: SearchableType.ENTITY,
        searchableId: 'e1',
        title: 'Applicant One',
        content: 'applicant one',
        metadata: { assignedTo: 'client-a' },
      },
      {
        id: 'r2',
        searchableType: SearchableType.ENTITY,
        searchableId: 'e2',
        title: 'Applicant Two',
        content: 'applicant two',
        metadata: { assignedTo: 'client-b' },
      },
    ];

    it('narrows results to their own records for a client actor', async () => {
      repo.find.mockResolvedValue(rows());
      const out = await service.search('t1', 'applicant', 20, {
        id: 'client-a',
        roles: ['client'],
      });
      expect(out.map((r) => r.searchableId)).toEqual(['e1']);
    });

    it('does not narrow results for staff', async () => {
      repo.find.mockResolvedValue(rows());
      const out = await service.search('t1', 'applicant', 20, {
        id: 'staff-1',
        roles: ['staff'],
      });
      expect(out.map((r) => r.searchableId)).toEqual(['e1', 'e2']);
    });

    it('does not narrow results when no actor is passed — internal callers keep tenant-wide answers', async () => {
      repo.find.mockResolvedValue(rows());
      const out = await service.search('t1', 'applicant', 20);
      expect(out.map((r) => r.searchableId)).toEqual(['e1', 'e2']);
    });
  });
});
