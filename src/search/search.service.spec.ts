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
});
