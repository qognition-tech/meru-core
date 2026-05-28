export interface SearchDocument {
  id: string;
  tenantId: string;
  index: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  permissions?: {
    public: boolean;
    users?: string[];
    roles?: string[];
  };
  // For vector search
  embedding?: number[];
  // For faceting
  facets?: Record<string, string | number | boolean>;
}

export interface SearchQuery {
  query: string;
  filters?: SearchFilter[];
  sort?: SearchSort[];
  pagination?: {
    from?: number;
    size?: number;
  };
  highlights?: boolean;
  aggregations?: SearchAggregation[];
  // For vector/semantic search
  vectorSearch?: {
    embedding: number[];
    similarity?: 'cosine' | 'euclidean' | 'dot_product';
    k?: number;
  };
}

export interface SearchFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'range' | 'match' | 'match_phrase';
  value: any;
  nested?: SearchFilter[];
  boolean?: 'and' | 'or' | 'not';
}

export interface SearchSort {
  field: string;
  order: 'asc' | 'desc';
  mode?: 'min' | 'max' | 'sum' | 'avg' | 'median';
}

export interface SearchAggregation {
  name: string;
  type: 'terms' | 'date_histogram' | 'histogram' | 'range' | 'stats' | 'cardinality' | 'nested';
  field: string;
  options?: Record<string, any>;
  subAggregations?: SearchAggregation[];
}

export interface SearchResult {
  total: number;
  took: number;
  documents: SearchDocument[];
  highlights?: Record<string, string[]>[];
  aggregations?: Record<string, AggregationResult>;
  suggestions?: string[];
  didYouMean?: string;
}

export interface AggregationResult {
  buckets?: Array<{
    key: string | number;
    docCount: number;
    subAggregations?: Record<string, AggregationResult>;
  }>;
  value?: number;
  values?: number[];
  stats?: {
    count: number;
    min: number;
    max: number;
    avg: number;
    sum: number;
  };
}

export interface IndexMapping {
  properties: Record<string, {
    type: 'text' | 'keyword' | 'integer' | 'long' | 'float' | 'double' | 'boolean' | 'date' | 'object' | 'nested' | 'geo_point' | 'dense_vector';
    fields?: Record<string, any>;
    analyzer?: string;
    searchAnalyzer?: string;
    format?: string;
    dims?: number; // For dense_vector
    similarity?: string;
    properties?: IndexMapping['properties']; // For nested/object
  }>;
  settings?: {
    numberOfShards?: number;
    numberOfReplicas?: number;
    analysis?: {
      analyzers?: Record<string, any>;
      tokenizers?: Record<string, any>;
      filters?: Record<string, any>;
    };
  };
}

export interface SuggestOptions {
  text: string;
  field?: string;
  size?: number;
  fuzzy?: boolean | { fuzziness: string | number };
}

export interface BulkIndexOperation {
  index?: string;
  id?: string;
  document: Partial<SearchDocument>;
  operation: 'index' | 'create' | 'update' | 'delete';
}

export interface BulkIndexResult {
  took: number;
  errors: boolean;
  items: Array<{
    operation: string;
    index: string;
    id: string;
    result?: string;
    status: number;
    error?: any;
  }>;
  total: number;
  successful: number;
  failed: number;
}

export interface SearchIndexStats {
  index: string;
  docCount: number;
  sizeInBytes: number;
  health: 'green' | 'yellow' | 'red';
  status: 'open' | 'close';
  shards: {
    total: number;
    successful: number;
    failed: number;
  };
}

export interface SearchAnalytics {
  totalQueries: number;
  avgResponseTime: number;
  popularQueries: Array<{ query: string; count: number }>;
  zeroResultsQueries: Array<{ query: string; count: number }>;
  queryLatencyDistribution: Record<string, number>;
}
