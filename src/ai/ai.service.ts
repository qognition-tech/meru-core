import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  AiPrompt,
  ModelProvider,
  PromptCategory,
} from './entities/ai-prompt.entity';
import { AiEmbedding } from './entities/ai-prompt.entity';
import { OpenAI } from 'openai';
import { VerticalType } from '../iam/enums/vertical.enum';
import { InstanceStatus } from '../workflow/entities/workflow-instance.entity';
import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import { CrmService } from '../crm/crm.service';
import { WorkflowEngineService } from '../workflow/workflow.service';
import { TaskService } from '../tasks/task.service';
import { FormBuilderService } from '../forms/form-builder.service';
import { DocumentsService } from '../documents/documents.service';
import { BillingService } from '../billing/billing.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { ConnectorsService } from '../integrations/services/connectors.service';
import type { PackPrompt } from '../../packages/config-packs/_schema/pack.schema';

/**
 * A prompt the gateway can execute, whichever layer it came from.
 *
 * `AiPrompt` (a tenant's own row) and a config-pack `prompts[]` entry describe
 * the same thing with different field names, and the execution path only ever
 * needed three of those fields. Normalising here keeps `executeOpenAI` from
 * caring which layer won, and `source` keeps that decision visible in a log
 * when a tenant swears it is running a prompt it overrode.
 */
interface ResolvedPrompt {
  key: string;
  prompt: string;
  preferredProvider: ModelProvider;
  modelConfig: { model?: string; temperature?: number; maxTokens?: number };
  source: 'tenant_override' | 'config_pack';
  packCode?: string;
}

export interface AiRequest {
  category: PromptCategory;
  key?: string;
  input: string;
  context?: Record<string, any>;
  vertical?: VerticalType;
  tenantId?: string;
}

export interface AiCitation {
  title: string;
  url: string;
  excerpt?: string;
}

// CLAUDE.md §6.3: ALL AI responses must include inline citations.
// If sources is empty, the CitationEnforcementInterceptor replaces the
// response with a standard "no verified source" fallback.
export interface AiResponse {
  result: string;
  model: string;
  provider: ModelProvider;
  tokensUsed?: number;
  cached: boolean;
  sources: AiCitation[]; // mandatory — empty = response will be suppressed
  citationEnforced: boolean; // true = passed citation check; false = fallback applied
}

export interface CrossModuleContext {
  crm?: unknown;
  workflow?: unknown;
  tasks?: unknown;
  documents?: unknown;
  forms?: unknown;
  billing?: unknown;
  analytics?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AuditLogRecord {
  severity?: string;
  action?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openaiClient: OpenAI | null;
  private requestQueue: Array<() => Promise<unknown>> = [];
  private readonly MAX_CONCURRENT = 5;

  constructor(
    @InjectRepository(AiPrompt)
    private promptRepo: Repository<AiPrompt>,
    @InjectRepository(AiEmbedding)
    private embeddingRepo: Repository<AiEmbedding>,
    @Inject(forwardRef(() => CrmService))
    private crmService: CrmService,
    @Inject(forwardRef(() => WorkflowEngineService))
    private workflowService: WorkflowEngineService,
    @Inject(forwardRef(() => TaskService))
    private taskService: TaskService,
    @Inject(forwardRef(() => FormBuilderService))
    private formService: FormBuilderService,
    @Inject(forwardRef(() => DocumentsService))
    private documentsService: DocumentsService,
    @Inject(forwardRef(() => BillingService))
    private billingService: BillingService,
    @Inject(forwardRef(() => AnalyticsService))
    private analyticsService: AnalyticsService,
    @Inject(forwardRef(() => AuditService))
    private auditService: AuditService,
    private readonly packs: VerticalPackService,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {
    if (process.env.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 3,
        timeout: 30000,
      });
    } else {
      this.logger.warn('OPENAI_API_KEY not set. AI features will be disabled.');
    }

    this.logger.log(
      `AI Service initialized with concurrency limit: ${this.MAX_CONCURRENT}`,
    );
  }

  async execute(request: AiRequest): Promise<AiResponse> {
    const { prompt, reason, packCode } = await this.resolvePrompt(request);

    if (!prompt) {
      const wanted = `${request.category}${request.key ? `/${request.key}` : ''}`;

      // These are two different failures and they used to be the same bare
      // `Error`, which the exception filter rendered as a 500. In production
      // that meant every single `POST /ai/execute` answered
      // `500 Prompt not found` — an internal-fault code for what was really an
      // unpopulated library, on a route recorded as shipped.
      //
      //  - Nothing anywhere defines prompts → the deployment is unconfigured.
      //    503, and name the pack so it is actionable.
      //  - Prompts exist but not this one → the caller asked for something
      //    that does not exist. 404.
      if (reason === 'no_library') {
        throw new ServiceUnavailableException(
          packCode
            ? `No AI prompts are configured: config pack '${packCode}' defines none, and this tenant has no prompt overrides. Add a prompts[] entry to the pack.`
            : 'No AI prompts are configured for this tenant’s vertical (no config pack resolved).',
        );
      }

      throw new NotFoundException(
        `No AI prompt matches '${wanted}'${packCode ? ` in config pack '${packCode}' or this tenant's overrides` : ''}.`,
      );
    }

    const fullPrompt = this.buildPrompt(prompt, request);

    try {
      switch (prompt.preferredProvider) {
        case ModelProvider.OPENAI:
          return await this.executeOpenAI(fullPrompt, prompt, request.tenantId);
        case ModelProvider.LOCAL:
          return await this.executeLocal(fullPrompt, prompt, request.tenantId);
        default:
          return await this.executeOpenAI(fullPrompt, prompt, request.tenantId);
      }
    } catch (error: unknown) {
      this.logger.error(`AI execution failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async analyzeEntity(
    tenantId: string,
    entityData: any,
    vertical: VerticalType,
  ): Promise<AiResponse> {
    return this.execute({
      category: PromptCategory.ENTITY_ANALYSIS,
      key: `${vertical}_entity_analysis`,
      input: JSON.stringify(entityData),
      context: { vertical, tenantId },
      vertical,
      tenantId,
    });
  }

  async extractFromDocument(
    documentContent: string,
    fields: string[],
  ): Promise<AiResponse> {
    return this.execute({
      category: PromptCategory.DATA_EXTRACTION,
      key: 'document_extraction',
      input: documentContent,
      context: { fields },
    });
  }

  async validateFormData(
    formData: Record<string, any>,
    validationRules: any[],
  ): Promise<AiResponse> {
    return this.execute({
      category: PromptCategory.VALIDATION,
      key: 'form_validation',
      input: JSON.stringify(formData),
      context: { validationRules },
    });
  }

  async createEmbedding(
    tenantId: string,
    text: string,
    type: string,
    resourceId: string,
    metadata: Record<string, any> = {},
  ) {
    if (!this.openaiClient) {
      // 503, not a bare Error. An unset OPENAI_API_KEY is a deployment gap,
      // not a bug in the request — a 500 tells the caller they broke something
      // and tells the on-call engineer to look for a crash. 503 says the
      // dependency is missing, which is what is actually true and what a
      // client should retry against.
      throw new ServiceUnavailableException(
        'AI is not configured on this deployment (OPENAI_API_KEY unset).',
      );
    }

    try {
      const response = await this.openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      const vector = response.data[0].embedding;
      const vectorId = response.data[0].index.toString();

      const embedding = this.embeddingRepo.create({
        tenantId,
        vectorId,
        type,
        resourceId,
        vector,
        metadata,
      });

      await this.embeddingRepo.save(embedding);

      return { embeddingId: embedding.id, vectorId };
    } catch (error: unknown) {
      this.logger.error(`Failed to create embedding: ${errorMessage(error)}`);
      throw error;
    }
  }

  async semanticSearch(
    tenantId: string,
    query: string,
    type?: string,
    limit: number = 5,
  ): Promise<any[]> {
    if (!this.openaiClient) {
      // 503, not a bare Error. An unset OPENAI_API_KEY is a deployment gap,
      // not a bug in the request — a 500 tells the caller they broke something
      // and tells the on-call engineer to look for a crash. 503 says the
      // dependency is missing, which is what is actually true and what a
      // client should retry against.
      throw new ServiceUnavailableException(
        'AI is not configured on this deployment (OPENAI_API_KEY unset).',
      );
    }

    try {
      const queryResponse = await this.openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
      });

      const queryVector = queryResponse.data[0].embedding;
      const embeddings = await this.embeddingRepo.find({
        where: { tenantId, ...(type && { type }) },
      });

      const results = embeddings.map((emb) => ({
        ...emb,
        similarity: this.cosineSimilarity(queryVector, emb.vector),
      }));

      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } catch (error: unknown) {
      this.logger.error(`Semantic search failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async upsertPrompt(prompt: Partial<AiPrompt>): Promise<AiPrompt> {
    if (!prompt.key) {
      throw new Error('Prompt key is required');
    }

    const existing = await this.promptRepo.findOne({
      where: { key: prompt.key },
    });

    if (existing) {
      return this.promptRepo.save({ ...existing, ...prompt });
    }

    return this.promptRepo.save(prompt as AiPrompt);
  }

  async getPromptsByCategory(
    category: PromptCategory,
    tenantId?: string,
  ): Promise<AiPrompt[]> {
    if (tenantId) {
      return this.promptRepo.find({
        where: { category, tenantId },
      });
    }
    return this.promptRepo.find({
      where: { category },
    });
  }

  /**
   * Two layers, in precedence order: a tenant's own `ai_prompts` rows, then the
   * vertical's config-pack library.
   *
   * The pack layer is what makes the gateway work at all. `ai_prompts` is a
   * per-tenant table that has to be seeded per tenant, and nobody ever seeded
   * it — production served `[]` from `GET /ai/prompts` and a 500 from every
   * `POST /ai/execute`. A pack ships with the vertical, so a tenant inherits a
   * working library the moment its pack is pinned, and `ai_prompts` goes back to
   * being what it should always have been: the override.
   *
   * `reason` distinguishes "nothing is configured anywhere" from "that specific
   * prompt does not exist", because the caller's next action differs and a
   * single "not found" tells them nothing about which one they are looking at.
   */
  private async resolvePrompt(request: AiRequest): Promise<{
    prompt: ResolvedPrompt | null;
    reason: 'found' | 'no_library' | 'no_match';
    packCode?: string;
  }> {
    // ── Layer 1: tenant override ────────────────────────────────────────
    const where: FindOptionsWhere<AiPrompt> = { category: request.category };
    if (request.key) where.key = request.key;
    else if (request.tenantId) where.tenantId = request.tenantId;

    const row = await this.promptRepo.findOne({ where });
    if (row) {
      return {
        prompt: {
          key: row.key,
          prompt: row.prompt,
          preferredProvider: row.preferredProvider,
          modelConfig: row.modelConfig ?? {},
          source: 'tenant_override',
        },
        reason: 'found',
      };
    }

    // ── Layer 2: the vertical's pack ────────────────────────────────────
    const { pack, section } = await this.packs.sectionWithPack<PackPrompt[]>(
      request.vertical ?? null,
      'prompts',
    );
    const library = Array.isArray(section) ? section : [];

    if (library.length === 0) {
      return { prompt: null, reason: 'no_library', packCode: pack?.code };
    }

    const candidates = library.filter((p) => p.category === request.category);
    const match = request.key
      ? candidates.find((p) => p.key === request.key)
      : // No key named: the category default, falling back to the first entry
        // in the category so a pack that forgot the flag still answers rather
        // than 404-ing on a prompt it plainly contains.
        (candidates.find((p) => p.isCategoryDefault) ?? candidates[0]);

    if (!match) {
      return { prompt: null, reason: 'no_match', packCode: pack?.code };
    }

    return {
      prompt: {
        key: match.key,
        prompt: match.prompt,
        preferredProvider: this.toProvider(match.provider),
        modelConfig: {
          model: match.model,
          temperature: match.temperature,
          maxTokens: match.maxTokens,
        },
        source: 'config_pack',
        packCode: pack?.code,
      },
      reason: 'found',
    };
  }

  /**
   * Pack `provider` strings are the same three words as `ModelProvider`, but a
   * pack is authored by hand and validated by Zod, not by this enum. Mapping
   * explicitly means an unexpected value degrades to OpenAI rather than
   * reaching the switch in `execute` as an unmatched case.
   */
  private toProvider(provider: string): ModelProvider {
    switch (provider) {
      case 'anthropic':
        // No Anthropic client is constructed yet; the pack may legitimately
        // ask for it, so route to the working provider instead of failing.
        return ModelProvider.OPENAI;
      case 'local':
        return ModelProvider.LOCAL;
      case 'openai':
      default:
        return ModelProvider.OPENAI;
    }
  }

  private buildPrompt(prompt: ResolvedPrompt, request: AiRequest): string {
    let builtPrompt = prompt.prompt;

    builtPrompt = builtPrompt.replace('{{INPUT}}', request.input || '');
    builtPrompt = builtPrompt.replace(
      '{{VERTICAL}}',
      request.vertical || 'default',
    );
    builtPrompt = builtPrompt.replace('{{TENANT_ID}}', request.tenantId || '');

    if (request.context) {
      Object.entries(request.context).forEach(([key, value]) => {
        builtPrompt = builtPrompt.replace(
          `{{${key.toUpperCase()}}}`,
          JSON.stringify(value),
        );
      });
    }

    return builtPrompt;
  }

  /**
   * The client to use for one request: the tenant's own connected provider if
   * it has one, otherwise the platform key.
   *
   * Tenant-first matters for more than convenience. A firm that supplies its own
   * key pays its own inference bill, keeps its prompts inside its own vendor
   * relationship, and can point `custom-openai-compatible` at a self-hosted
   * model when data residency forbids sending case data to a US endpoint. That
   * last one is a compliance requirement in several of the corridor countries,
   * not a preference.
   *
   * Not cached: a key revoked in the UI must stop working on the next request,
   * and one connector lookup is cheap next to a model call.
   */
  private async clientFor(tenantId?: string): Promise<{
    client: OpenAI;
    defaultModel: string | null;
    source: 'tenant_connector' | 'platform';
  }> {
    if (tenantId) {
      const provider = await this.connectors.resolveAiProvider(tenantId);
      if (provider?.apiKey || provider?.baseUrl) {
        return {
          client: new OpenAI({
            // An OpenAI-compatible endpoint may legitimately need no key (a
            // self-hosted vLLM on a private network). The SDK still requires a
            // non-empty string, so send a placeholder rather than refusing a
            // valid configuration.
            apiKey: provider.apiKey ?? 'not-required',
            baseURL: provider.baseUrl ?? undefined,
            maxRetries: 3,
            timeout: 30000,
          }),
          defaultModel: provider.model,
          source: 'tenant_connector',
        };
      }
    }

    if (!this.openaiClient) {
      // 503, not a bare Error. A missing model credential is a deployment gap,
      // not a bug in the request — a 500 tells the caller they broke something
      // and tells the on-call engineer to look for a crash. 503 says the
      // dependency is missing, which is what is actually true and what a
      // client should retry against. The message now names both remedies,
      // because a tenant admin can fix this themselves and should be told so.
      throw new ServiceUnavailableException(
        'AI is not configured: this tenant has no AI provider connected ' +
          '(PUT /integrations/connectors/openai) and the platform has no ' +
          'OPENAI_API_KEY set.',
      );
    }

    return {
      client: this.openaiClient,
      defaultModel: null,
      source: 'platform',
    };
  }

  private async executeOpenAI(
    fullPrompt: string,
    prompt: ResolvedPrompt,
    tenantId?: string,
  ): Promise<AiResponse> {
    const { client, defaultModel } = await this.clientFor(tenantId);

    const config = prompt.modelConfig || {};
    // Precedence: the prompt's own model, then the tenant provider's, then the
    // platform default. A pack that pins a model is being deliberate — usually
    // because the prompt was tuned against it — so it outranks a tenant-level
    // preference.
    const model = config.model || defaultModel || 'gpt-4o-mini';

    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 500,
      });

      const rawResult = response.choices[0].message.content || '';
      const { result, sources } = this.extractCitations(rawResult);

      return {
        result,
        model,
        provider: ModelProvider.OPENAI,
        tokensUsed: response.usage?.total_tokens,
        cached: false,
        sources,
        citationEnforced: false, // CitationEnforcementInterceptor sets this
      };
    } catch (error: unknown) {
      this.logger.error(`OpenAI execution failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async executeLocal(
    fullPrompt: string,
    prompt: ResolvedPrompt,
    tenantId?: string,
  ): Promise<AiResponse> {
    // A pack asking for `local` is asking for a self-hosted model, which is
    // exactly what the `custom-openai-compatible` connector provides — so this
    // is no longer a dead end, it just routes through the tenant's endpoint if
    // one is connected.
    this.logger.warn(
      'Local provider requested; routing through the tenant connector or platform client',
    );
    return this.executeOpenAI(fullPrompt, prompt, tenantId);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must be of same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async healthCheck(): Promise<{ openaiAvailable: boolean; status: string }> {
    const isAvailable = !!this.openaiClient;
    return {
      openaiAvailable: isAvailable,
      status: isAvailable ? 'healthy' : 'degraded',
    };
  }

  // ==================== CROSS-MODULE AI INTEGRATION ====================

  /**
   * Get comprehensive context from all modules for AI processing
   */
  async gatherCrossModuleContext(
    tenantId: string,
    entityId?: string,
    entityType?: string,
  ): Promise<CrossModuleContext> {
    const context: CrossModuleContext = {};

    try {
      // CRM Context
      if (entityId && entityType === 'crm_entity') {
        context.crm = await this.crmService.findEntityById(entityId);
      }

      // Workflow Context - Get active workflows
      context.workflow = await this.workflowService.listInstances(
        tenantId,
        InstanceStatus.ACTIVE,
      );

      // Tasks Context - Get pending tasks
      context.tasks = await this.taskService.listTasks(tenantId, {
        status: 'todo' as any,
      });

      // Documents Context - Get recent documents
      context.documents = await this.documentsService.findAll(tenantId, {
        page: 1,
        limit: 10,
      });

      // Billing Context - Get subscription and usage
      const subscriptions = await this.billingService['subscriptionRepo']?.find(
        {
          where: { tenantId, status: SubscriptionStatus.ACTIVE },
        },
      );
      context.billing = { subscriptions: subscriptions || [] };

      // Analytics Context - Get recent reports
      context.analytics = await this.analyticsService.getReports(tenantId);
    } catch (error: unknown) {
      this.logger.warn(
        'Error gathering cross-module context:',
        errorMessage(error),
      );
    }

    return context;
  }

  /**
   * AI-powered cross-module insights
   */
  async generateCrossModuleInsights(
    tenantId: string,
    query: string,
  ): Promise<AiResponse> {
    const context = await this.gatherCrossModuleContext(tenantId);

    return this.execute({
      category: 'cross_module_analysis' as PromptCategory,
      key: 'comprehensive_insights',
      input: query,
      context: {
        tenantId,
        crm: context.crm,
        workflow: context.workflow,
        tasks: context.tasks,
        documents: context.documents,
        billing: context.billing,
        analytics: context.analytics,
      },
      tenantId,
    });
  }

  /**
   * AI Workflow Recommendation
   */
  async recommendWorkflow(
    tenantId: string,
    entityType: string,
    entityData: any,
  ): Promise<AiResponse> {
    // Get existing workflows
    const workflows = await this.workflowService.listWorkflows(
      tenantId,
      entityType,
    );

    return this.execute({
      category: 'workflow_decision' as PromptCategory,
      key: 'workflow_recommendation',
      input: JSON.stringify({
        entityType,
        entityData,
        availableWorkflows: workflows.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
        })),
      }),
      tenantId,
    });
  }

  /**
   * AI Task Prioritization
   */
  async prioritizeTasks(tenantId: string, userId: string): Promise<AiResponse> {
    const tasks = await this.taskService.listTasks(tenantId, {
      assignedTo: userId,
    });

    return this.execute({
      category: 'workflow_decision' as PromptCategory,
      key: 'task_prioritization',
      input: JSON.stringify({
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          dueDate: t.dueDate,
          type: t.type,
        })),
      }),
      context: { userId },
      tenantId,
    });
  }

  /**
   * AI Document Classification
   */
  async classifyDocument(
    tenantId: string,
    documentId: string,
  ): Promise<AiResponse> {
    const document = await this.documentsService.findOne(
      documentId,
      tenantId,
      'system',
    );

    return this.execute({
      category: 'document_analysis' as PromptCategory,
      key: 'document_classification',
      input: JSON.stringify({
        documentName: document.name,
        fileType: document.fileType,
        metadata: document.metadata,
      }),
      tenantId,
    });
  }

  /**
   * AI Billing Anomaly Detection
   */
  async detectBillingAnomalies(
    tenantId: string,
    subscriptionId: string,
  ): Promise<AiResponse> {
    const subscription = await this.billingService.getSubscription(
      subscriptionId,
      tenantId,
    );
    const usage = subscription.usage;

    return this.execute({
      category: 'data_analysis' as PromptCategory,
      key: 'billing_anomaly_detection',
      input: JSON.stringify({
        subscriptionId,
        planName: subscription.plan?.name,
        usage,
        currentPeriod: {
          start: subscription.currentPeriodStart,
          end: subscription.currentPeriodEnd,
        },
      }),
      tenantId,
    });
  }

  /**
   * AI Compliance Risk Assessment
   */
  async assessComplianceRisk(
    tenantId: string,
    standard: string,
  ): Promise<AiResponse> {
    const auditLogs = await this.auditService.queryLogs({
      tenantId,
      complianceStandard: standard as any,
      limit: 1000,
    });

    return this.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'compliance_risk_assessment',
      input: JSON.stringify({
        standard,
        auditLogSummary: {
          totalEvents: auditLogs.total,
          bySeverity: this.summarizeBySeverity(auditLogs.logs),
          byAction: this.summarizeByAction(auditLogs.logs),
        },
      }),
      tenantId,
    });
  }

  /**
   * AI Predictive Analytics
   */
  async predictTrends(
    tenantId: string,
    metric: string,
    timeframe: string,
  ): Promise<AiResponse> {
    // Get historical data from analytics
    const reports = await this.analyticsService.getReports(tenantId);

    return this.execute({
      category: 'predictive_analytics' as PromptCategory,
      key: 'trend_prediction',
      input: JSON.stringify({
        metric,
        timeframe,
        historicalReports: reports.map((r) => ({
          name: r.name,
          dataSource: r.dataSource,
        })),
      }),
      tenantId,
    });
  }

  /**
   * AI Smart Search across all modules
   */
  async smartSearch(
    tenantId: string,
    query: string,
    modules?: string[],
  ): Promise<{
    aiResponse: AiResponse;
    results: {
      crm?: any[];
      workflow?: any[];
      tasks?: any[];
      documents?: any[];
      forms?: any[];
    };
  }> {
    const searchModules = modules || [
      'crm',
      'workflow',
      'tasks',
      'documents',
      'forms',
    ];
    const results: any = {};

    // Search each module
    if (searchModules.includes('crm')) {
      try {
        // Get CRM entities (simplified)
        const entities = await this.crmService.getEntitiesByTenant(tenantId);
        results.crm = entities.filter((e) =>
          JSON.stringify(e).toLowerCase().includes(query.toLowerCase()),
        );
      } catch (e) {}
    }

    if (searchModules.includes('workflow')) {
      try {
        const instances = await this.workflowService.listInstances(tenantId);
        results.workflow = instances.filter((i) =>
          JSON.stringify(i).toLowerCase().includes(query.toLowerCase()),
        );
      } catch (e) {}
    }

    if (searchModules.includes('tasks')) {
      try {
        const tasks = await this.taskService.listTasks(tenantId);
        results.tasks = tasks.filter((t) =>
          JSON.stringify(t).toLowerCase().includes(query.toLowerCase()),
        );
      } catch (e) {}
    }

    if (searchModules.includes('documents')) {
      try {
        const docs = await this.documentsService.findAll(tenantId, {
          query,
          page: 1,
          limit: 20,
        });
        results.documents = docs.documents;
      } catch (e) {}
    }

    if (searchModules.includes('forms')) {
      try {
        const submissions = await this.formService.listSubmissions(tenantId);
        results.forms = submissions.filter((s) =>
          JSON.stringify(s).toLowerCase().includes(query.toLowerCase()),
        );
      } catch (e) {}
    }

    // AI analysis of results
    const aiResponse = await this.execute({
      category: 'data_analysis' as PromptCategory,
      key: 'smart_search_analysis',
      input: JSON.stringify({
        query,
        resultsSummary: {
          crmCount: results.crm?.length || 0,
          workflowCount: results.workflow?.length || 0,
          tasksCount: results.tasks?.length || 0,
          documentsCount: results.documents?.length || 0,
          formsCount: results.forms?.length || 0,
        },
      }),
      tenantId,
    });

    return { aiResponse, results };
  }

  // ==================== PRIVATE HELPERS ====================

  private summarizeBySeverity(logs: any[]): Record<string, number> {
    return logs.reduce((acc, log) => {
      acc[log.severity] = (acc[log.severity] || 0) + 1;
      return acc;
    }, {});
  }

  private summarizeByAction(logs: any[]): Record<string, number> {
    return logs.reduce((acc, log) => {
      acc[log.action] = (acc[log.action] || 0) + 1;
      return acc;
    }, {});
  }

  // ==================== CITATION HELPERS ====================

  // System prompt prefix injected on all GovAI regulatory calls.
  // CLAUDE.md §6.3: AI features without citation enforcement do not ship.
  static readonly CITATION_SYSTEM_PROMPT = `You are GovAI, a regulatory assistant powered by Meru.
STRICT RULES:
1. Only answer regulatory questions using verified official sources.
2. Every factual claim MUST be followed by [source: Title — URL].
3. If you cannot find an official source, respond ONLY with: "I don't have a verified source for this."
4. Never invent URLs or citations.
5. Use official government, regulator, or legislation URLs only.

Example:
"The 482 visa requires a skills assessment [source: Visa 482 — DHA — https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/temporary-skill-shortage-482]."
`;

  // Extracts [source: Title — URL] markers from AI response text.
  // Returns cleaned result string and structured sources array.
  extractCitations(text: string): { result: string; sources: AiCitation[] } {
    const sourcePattern = /\[source:\s*([^\]]+)\]/gi;
    const sources: AiCitation[] = [];

    let match: RegExpExecArray | null;
    while ((match = sourcePattern.exec(text)) !== null) {
      const raw = match[1].trim();
      const dashIdx = raw.indexOf('—');
      if (dashIdx !== -1) {
        sources.push({
          title: raw.slice(0, dashIdx).trim(),
          url: raw.slice(dashIdx + 1).trim(),
        });
      } else {
        sources.push({ title: raw, url: raw });
      }
    }

    const result = text.replace(/\[source:[^\]]*\]/gi, '').trim();
    return { result, sources };
  }
}
