import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { CrmService } from '../crm/crm.service';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';
import type { AiResponse } from '../ai/ai.service';
import { PromptCategory } from '../ai/entities/ai-prompt.entity';
import { VerticalType } from '../iam/enums/vertical.enum';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

interface CategorizationResult {
  primary?: string;
  confidence?: number;
  tags?: string[];
}

interface InsightsResult {
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  completeness?: number;
  actions?: string[];
}

export interface IntelligentSearchResponse {
  results: unknown;
  method: 'semantic' | 'keyword';
  enriched: boolean;
}

export interface EntityCreatedEvent {
  entityType: string;
  entityId: string;
  tenantId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);

  constructor(
    @Inject(forwardRef(() => CrmService))
    private crmService: CrmService,
    private searchService: SearchService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
  ) {}

  async onEntityCreated(event: EntityCreatedEvent): Promise<void> {
    this.logger.log(`Entity created: ${event.entityType}:${event.entityId}`);

    await Promise.allSettled([
      this.indexForSearch(event),
      this.analyzeWithAI(event),
    ]);
  }

  async performIntelligentSearch(
    tenantId: string,
    query: string,
    options: {
      includeAIAnalysis?: boolean;
      searchType?: 'semantic' | 'keyword' | 'hybrid';
      limit?: number;
    } = {},
  ): Promise<IntelligentSearchResponse | unknown[]> {
    this.logger.log(`Performing intelligent search: ${query}`, { options });

    const searchLimit = options.limit || 20;

    if (
      options.searchType === 'semantic' ||
      (!options.searchType && process.env.ENABLE_SEMANTIC_SEARCH === 'true')
    ) {
      const semanticResults = await this.aiService.semanticSearch(
        tenantId,
        query,
        undefined,
        searchLimit,
      );

      if (options.includeAIAnalysis) {
        return this.enrichWithAIAnalysis(semanticResults, query);
      }

      return {
        results: semanticResults,
        method: 'semantic',
        enriched: false,
      };
    }

    const keywordResults = await this.searchService.search(
      tenantId,
      query,
      searchLimit,
    );

    return {
      results: keywordResults,
      method: 'keyword',
      enriched: false,
    };
  }

  async autoCategorizeEntity(
    tenantId: string,
    entityId: string,
    entityType: string,
  ): Promise<{
    primaryCategory: string;
    confidence: number;
    suggestedTags: string[];
  }> {
    this.logger.log(`Auto-categorizing entity: ${entityId}`);

    try {
      const entity = await this.crmService.findEntityById(entityId);
      if (!entity) {
        throw new Error('Entity not found');
      }

      const categoryAnalysis = await this.aiService.execute({
        category: PromptCategory.DATA_EXTRACTION,
        key: 'entity_categorization',
        input: JSON.stringify({
          entityType,
          verticalAttributes: entity.verticalAttributes,
        }),
        context: {
          tenantId,
          vertical:
            (entity.verticalAttributes?.vertical as string | undefined) ||
            'default',
        },
      });

      const categories = JSON.parse(
        categoryAnalysis.result,
      ) as CategorizationResult;

      return {
        primaryCategory: categories.primary || 'uncategorized',
        confidence: categories.confidence || 0.5,
        suggestedTags: categories.tags || [],
      };
    } catch (error: unknown) {
      this.logger.error(`Auto-categorization failed: ${errorMessage(error)}`);

      return {
        primaryCategory: 'uncategorized',
        confidence: 0,
        suggestedTags: [],
      };
    }
  }

  /**
   * AI-generated insights about one record.
   *
   * Citations or silence (CLAUDE.md §5.3). The LLM answer is JSON, so the
   * `CitationEnforcementInterceptor` — which only knows how to replace a prose
   * `result` — cannot police the parsed fields on its own. The rule is applied
   * here instead: with no source, `riskLevel` is `null` and the actions list is
   * empty, with `citationEnforced: false` and an `unavailableReason`. The raw
   * `AiResponse` rides along as `ai` so the interceptor still stamps it.
   *
   * Never `riskLevel: 'low'` as a default. The previous version returned it on
   * every failure path, so an entity whose analysis had thrown looked like one
   * that had been examined and found unremarkable (§5.2).
   */
  async extractInsights(
    tenantId: string,
    entityId: string,
    tenantVertical?: string,
  ): Promise<{
    riskLevel: 'low' | 'medium' | 'high' | 'critical' | null;
    completeness: number | null;
    suggestedActions: string[];
    citationEnforced: boolean;
    unavailableReason?: string;
    ai?: AiResponse;
  }> {
    this.logger.log(`Extracting insights for entity: ${entityId}`);

    const unavailable = (unavailableReason: string, ai?: AiResponse) => ({
      riskLevel: null,
      completeness: null,
      suggestedActions: [],
      citationEnforced: false,
      unavailableReason,
      ...(ai ? { ai } : {}),
    });

    let insights: AiResponse;
    try {
      const entity = await this.crmService.findEntityById(entityId);
      if (!entity) {
        throw new Error('Entity not found');
      }

      const vertical = this.verticalOf(entity, tenantVertical);
      if (!vertical) {
        return unavailable(
          'Neither the record nor the tenant states a vertical, so no ' +
            'analysis prompt applies.',
        );
      }

      insights = await this.aiService.analyzeEntity(tenantId, entity, vertical);
    } catch (error: unknown) {
      this.logger.error(`Insight extraction failed: ${errorMessage(error)}`);
      return unavailable(`Insight extraction failed: ${errorMessage(error)}`);
    }

    if (!insights.sources || insights.sources.length === 0) {
      return unavailable(
        'The model cited no verified source, so its assessment is withheld.',
        insights,
      );
    }

    let parsed: InsightsResult;
    try {
      parsed = JSON.parse(insights.result) as InsightsResult;
    } catch {
      return unavailable('The model returned an unparseable assessment.', insights);
    }

    return {
      riskLevel: parsed.riskLevel ?? null,
      completeness: parsed.completeness ?? null,
      suggestedActions: parsed.actions || [],
      citationEnforced: true,
      ai: insights,
    };
  }

  /**
   * The vertical a record belongs to: the record's own, else the tenant's,
   * else nothing. This used to default to `immigration`, which put one
   * product's vocabulary in core (§5.5) and analysed a GRC counterparty with
   * an immigration prompt.
   */
  private verticalOf(
    entity: { verticalAttributes?: Record<string, unknown> | null },
    tenantVertical?: string,
  ): VerticalType | null {
    const known = Object.values(VerticalType) as string[];
    for (const candidate of [entity.verticalAttributes?.vertical, tenantVertical]) {
      if (typeof candidate === 'string' && known.includes(candidate)) {
        return candidate as VerticalType;
      }
    }
    return null;
  }

  async bulkIndexEntities(
    tenantId: string,
    entityIds: string[],
  ): Promise<{
    indexed: number;
    failed: number;
    errors: unknown[];
  }> {
    this.logger.log(`Bulk indexing ${entityIds.length} entities`);

    const results = await Promise.allSettled(
      entityIds.map(
        async (
          entityId,
        ): Promise<{
          entityId: string;
          success: boolean;
          error?: unknown;
        }> => {
          try {
            const entity = await this.crmService.findEntityById(entityId);
            if (entity) {
              await this.searchService.indexEntityData(entity);
              return { entityId, success: true };
            }
            return { entityId, success: false, error: 'Entity not found' };
          } catch (error) {
            return { entityId, success: false, error };
          }
        },
      ),
    );

    const indexed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.success,
    ).length;
    const failed = results.filter(
      (r) =>
        r.status === 'rejected' ||
        (r.status === 'fulfilled' && !r.value.success),
    ).length;
    const errors = results
      .filter(
        (r) =>
          r.status === 'rejected' ||
          (r.status === 'fulfilled' && !r.value.success),
      )
      .map((r): unknown =>
        r.status === 'rejected' ? (r.reason as unknown) : r.value.error,
      );

    this.logger.log(
      `Bulk indexing complete: ${indexed} success, ${failed} failed`,
    );

    return { indexed, failed, errors };
  }

  private async indexForSearch(event: EntityCreatedEvent): Promise<void> {
    try {
      const entity = await this.crmService.findEntityById(event.entityId);
      if (entity) {
        await this.searchService.indexEntityData(entity);
        this.logger.debug(`Entity indexed for search: ${event.entityId}`);
      }
    } catch (error: unknown) {
      this.logger.error(
        `Failed to index entity ${event.entityId}: ${errorMessage(error)}`,
        errorStack(error),
      );
    }
  }

  private async analyzeWithAI(event: EntityCreatedEvent): Promise<void> {
    try {
      await this.aiService.analyzeEntity(
        event.tenantId,
        {
          entityType: event.entityType,
          entityId: event.entityId,
          ...event.metadata,
        },
        VerticalType.IMMIGRATION,
      );

      this.logger.debug(`Entity analyzed with AI: ${event.entityId}`);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes('OPENAI_API_KEY not set')) {
        this.logger.debug(
          `AI analysis skipped (no API key): ${event.entityId}`,
        );
      } else {
        this.logger.error(
          `AI analysis failed for entity ${event.entityId}: ${message}`,
          errorStack(error),
        );
      }
    }
  }

  private filterSignificantChanges(
    changes: Record<string, { old: unknown; new: unknown }>,
  ): Array<string> {
    const significantFields = [
      'email',
      'phoneNumber',
      'firstName',
      'lastName',
      'taxId',
    ];
    const significant: Array<string> = [];

    for (const [field] of Object.keys(changes)) {
      if (significantFields.includes(field)) {
        significant.push(field);
      }
    }

    return significant;
  }

  /**
   * Per-result AI annotations on a search. Each result carries the raw
   * `AiResponse` as `aiInsights.ai` so the interceptor enforces it; the parsed
   * object is only attached when the model cited a source, otherwise the
   * result says so rather than carrying an unsourced annotation.
   */
  private async enrichWithAIAnalysis(
    results: unknown[],
    query: string,
  ): Promise<unknown[]> {
    try {
      const enriched = await Promise.all(
        results.slice(0, 5).map(async (result) => {
          const insights = await this.aiService.execute({
            category: PromptCategory.DATA_EXTRACTION,
            key: 'search_result_enrichment',
            input: JSON.stringify({ result, originalQuery: query }),
          });

          const cited = insights.sources && insights.sources.length > 0;
          let parsed: unknown = null;
          if (cited) {
            try {
              parsed = JSON.parse(insights.result) as unknown;
            } catch {
              parsed = null;
            }
          }

          return {
            ...(result as Record<string, unknown>),
            aiInsights: {
              parsed,
              citationEnforced: cited,
              ...(cited
                ? {}
                : { unavailableReason: 'No verified source; annotation withheld.' }),
              ai: insights,
            },
          };
        }),
      );

      return [...enriched, ...results.slice(5)];
    } catch (error: unknown) {
      this.logger.error(`AI enrichment failed: ${errorMessage(error)}`);
      return results;
    }
  }

  async healthCheck(): Promise<{
    status: string;
    services: Record<string, boolean>;
  }> {
    const checks = {
      crm: true,
      search: true,
      ai: false,
    };

    try {
      const aiHealth = await this.aiService.healthCheck();
      checks.ai = aiHealth.openaiAvailable;
    } catch (error) {
      this.logger.error('AI health check failed', error);
      checks.ai = false;
    }

    const allHealthy = Object.values(checks).every((v) => v === true);

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      services: checks,
    };
  }
}
