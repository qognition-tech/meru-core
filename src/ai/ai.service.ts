import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

export interface AiRequest {
  category: PromptCategory;
  key?: string;
  input: string;
  context?: Record<string, any>;
  vertical?: VerticalType;
  tenantId?: string;
}

export interface AiResponse {
  result: string;
  model: string;
  provider: ModelProvider;
  tokensUsed?: number;
  cached: boolean;
}

export interface CrossModuleContext {
  crm?: any;
  workflow?: any;
  tasks?: any;
  documents?: any;
  forms?: any;
  billing?: any;
  analytics?: any;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openaiClient: OpenAI | null;
  private requestQueue: Array<() => Promise<any>> = [];
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
    const prompt = await this.findPrompt(request);

    if (!prompt) {
      throw new Error(
        `Prompt not found: ${request.category}${request.key ? `/${request.key}` : ''}`,
      );
    }

    const fullPrompt = this.buildPrompt(prompt, request);

    try {
      switch (prompt.preferredProvider) {
        case ModelProvider.OPENAI:
          return await this.executeOpenAI(fullPrompt, prompt);
        case ModelProvider.LOCAL:
          return await this.executeLocal(fullPrompt, prompt);
        default:
          return await this.executeOpenAI(fullPrompt, prompt);
      }
    } catch (error: any) {
      this.logger.error(`AI execution failed: ${error.message}`);
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
      throw new Error(
        'OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.',
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
    } catch (error) {
      this.logger.error(`Failed to create embedding: ${error.message}`);
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
      throw new Error(
        'OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.',
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
    } catch (error) {
      this.logger.error(`Semantic search failed: ${error.message}`);
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

  private async findPrompt(request: AiRequest): Promise<AiPrompt | null> {
    if (request.key) {
      return this.promptRepo.findOne({
        where: {
          key: request.key,
          category: request.category,
        },
      });
    }

    const where: any = { category: request.category };
    if (request.tenantId) {
      where.tenantId = request.tenantId;
    }

    return this.promptRepo.findOne({ where });
  }

  private buildPrompt(prompt: AiPrompt, request: AiRequest): string {
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

  private async executeOpenAI(
    fullPrompt: string,
    prompt: AiPrompt,
  ): Promise<AiResponse> {
    if (!this.openaiClient) {
      throw new Error(
        'OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.',
      );
    }

    const config = prompt.modelConfig || {};

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: config.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 500,
      });

      return {
        result: response.choices[0].message.content || '',
        model: config.model || 'gpt-4o-mini',
        provider: ModelProvider.OPENAI,
        tokensUsed: response.usage?.total_tokens,
        cached: false,
      };
    } catch (error) {
      this.logger.error(`OpenAI execution failed: ${error.message}`);
      throw error;
    }
  }

  private async executeLocal(
    fullPrompt: string,
    prompt: AiPrompt,
  ): Promise<AiResponse> {
    this.logger.warn(
      'Local model execution not yet implemented, falling back to OpenAI',
    );
    return this.executeOpenAI(fullPrompt, prompt);
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
    } catch (error) {
      this.logger.warn('Error gathering cross-module context:', error.message);
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
}
