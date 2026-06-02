import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  Workflow,
  WorkflowStatus,
  WorkflowTrigger,
} from './entities/workflow.entity';
import { WorkflowState, StateType } from './entities/workflow-state.entity';
import {
  WorkflowTransition,
  TransitionType,
} from './entities/workflow-transition.entity';
import {
  WorkflowInstance,
  InstanceStatus,
} from './entities/workflow-instance.entity';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';
import { DocumentHubService } from '../documents/document-hub.service';
import { Document } from '../documents/entities/document.entity';

export interface TransitionRequest {
  instanceId: string;
  transitionId?: string;
  userId: string;
  context?: Record<string, any>;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  entityType: string;
  states: Array<{
    name: string;
    type: StateType;
    description?: string;
    config?: Record<string, any>;
  }>;
  transitions: Array<{
    name: string;
    from: string;
    to: string;
    type: TransitionType;
    conditions?: Record<string, any>;
    actions?: Array<Record<string, any>>;
    permissions?: Record<string, any>;
  }>;
  trigger?: WorkflowTrigger;
  triggerConfig?: Record<string, any>;
  slaConfig?: Record<string, any>;
}

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    @InjectRepository(Workflow)
    private workflowRepo: Repository<Workflow>,
    @InjectRepository(WorkflowState)
    private stateRepo: Repository<WorkflowState>,
    @InjectRepository(WorkflowTransition)
    private transitionRepo: Repository<WorkflowTransition>,
    @InjectRepository(WorkflowInstance)
    private instanceRepo: Repository<WorkflowInstance>,
    private dataSource: DataSource,
    private searchService: SearchService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
    @Inject(forwardRef(() => DocumentHubService))
    private documentHubService: DocumentHubService,
  ) {}

  // ==================== WORKFLOW DEFINITION ====================

  async createWorkflow(
    tenantId: string,
    definition: WorkflowDefinition,
    userId: string,
  ): Promise<Workflow> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Create workflow
      const workflow = queryRunner.manager.create(Workflow, {
        tenantId,
        name: definition.name,
        description: definition.description,
        entityType: definition.entityType,
        trigger: definition.trigger || WorkflowTrigger.MANUAL,
        triggerConfig: definition.triggerConfig || {},
        slaConfig: definition.slaConfig || { enabled: false },
        version: 1,
        status: WorkflowStatus.DRAFT,
      });

      const savedWorkflow = await queryRunner.manager.save(workflow);

      // Create states
      const stateMap = new Map<string, WorkflowState>();
      for (const stateDef of definition.states) {
        const state = queryRunner.manager.create(WorkflowState, {
          workflowId: savedWorkflow.id,
          name: stateDef.name,
          type: stateDef.type,
          description: stateDef.description,
          config: stateDef.config || {},
        });
        const savedState = await queryRunner.manager.save(state);
        stateMap.set(stateDef.name, savedState);
      }

      // Create transitions
      for (const transDef of definition.transitions) {
        const fromState = stateMap.get(transDef.from);
        const toState = stateMap.get(transDef.to);

        if (!fromState || !toState) {
          throw new BadRequestException(
            `Invalid transition: ${transDef.from} -> ${transDef.to}`,
          );
        }

        const transition = queryRunner.manager.create(WorkflowTransition, {
          workflowId: savedWorkflow.id,
          fromStateId: fromState.id,
          toStateId: toState.id,
          name: transDef.name,
          type: transDef.type || TransitionType.MANUAL,
          conditions: transDef.conditions || { operator: 'AND', rules: [] },
          actions: transDef.actions || [],
          permissions: transDef.permissions || { roles: [], users: [] },
        });
        await queryRunner.manager.save(transition);
      }

      await queryRunner.commitTransaction();
      this.logger.log(`Workflow created: ${savedWorkflow.id}`);

      return this.getWorkflow(savedWorkflow.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getWorkflow(id: string): Promise<Workflow> {
    const workflow = await this.workflowRepo.findOne({
      where: { id },
      relations: ['states', 'transitions'],
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    return workflow;
  }

  async listWorkflows(
    tenantId: string,
    entityType?: string,
  ): Promise<Workflow[]> {
    const where: any = { tenantId };
    if (entityType) {
      where.entityType = entityType;
    }

    return this.workflowRepo.find({
      where,
      relations: ['states', 'transitions'],
      order: { createdAt: 'DESC' },
    });
  }

  // ==================== WORKFLOW INSTANCES ====================

  async startWorkflow(
    workflowId: string,
    entityId: string,
    entityType: string,
    tenantId: string,
    userId: string,
    context: Record<string, any> = {},
  ): Promise<WorkflowInstance> {
    const workflow = await this.getWorkflow(workflowId);

    if (workflow.status !== WorkflowStatus.ACTIVE) {
      throw new BadRequestException('Workflow is not active');
    }

    const startState = workflow.states.find((s) => s.type === StateType.START);

    if (!startState) {
      throw new BadRequestException('No start state defined');
    }

    // Calculate SLA deadline if enabled
    let slaDeadline: Date | null = null;
    if (workflow.slaConfig?.enabled && startState.config?.slaHours) {
      slaDeadline = new Date();
      slaDeadline.setHours(slaDeadline.getHours() + startState.config.slaHours);
    }

    const instance = this.instanceRepo.create({
      tenantId,
      workflowId,
      entityId,
      entityType,
      currentStateId: startState.id,
      status: InstanceStatus.ACTIVE,
      context,
      history: [],
      stateEnteredAt: new Date(),
      slaDeadline,
      escalationLevel: 0,
      startedBy: userId,
    });

    const saved = await this.instanceRepo.save(instance);
    this.logger.log(`Workflow instance started: ${saved.id}`);

    return this.getInstance(saved.id);
  }

  async getInstance(id: string): Promise<WorkflowInstance> {
    const instance = await this.instanceRepo.findOne({
      where: { id },
      relations: ['workflow', 'currentState'],
    });

    if (!instance) {
      throw new NotFoundException('Workflow instance not found');
    }

    return instance;
  }

  async listInstances(
    tenantId: string,
    status?: InstanceStatus,
    entityId?: string,
  ): Promise<WorkflowInstance[]> {
    const where: any = { tenantId };
    if (status) where.status = status;
    if (entityId) where.entityId = entityId;

    return this.instanceRepo.find({
      where,
      relations: ['workflow', 'currentState'],
      order: { createdAt: 'DESC' },
    });
  }

  // ==================== STATE TRANSITIONS ====================

  async getAvailableTransitions(
    instanceId: string,
  ): Promise<WorkflowTransition[]> {
    const instance = await this.getInstance(instanceId);

    const transitions = await this.transitionRepo.find({
      where: {
        workflowId: instance.workflowId,
        fromStateId: instance.currentStateId,
        isActive: true,
      },
      relations: ['fromState', 'toState'],
    });

    return transitions.filter((t) =>
      this.evaluateConditions(t.conditions, instance.context),
    );
  }

  async transition(request: TransitionRequest): Promise<WorkflowInstance> {
    const instance = await this.getInstance(request.instanceId);

    if (instance.status !== InstanceStatus.ACTIVE) {
      throw new BadRequestException('Workflow instance is not active');
    }

    let transition: WorkflowTransition | null = null;

    if (request.transitionId) {
      transition = await this.transitionRepo.findOne({
        where: {
          id: request.transitionId,
          fromStateId: instance.currentStateId,
          isActive: true,
        },
        relations: ['toState'],
      });
    } else {
      // Auto-transition: find first matching automatic transition
      const transitions = await this.getAvailableTransitions(
        request.instanceId,
      );
      const autoTransition = transitions.find(
        (t) => t.type === TransitionType.AUTOMATIC,
      );
      transition = autoTransition || null;
    }

    if (!transition) {
      throw new BadRequestException('No valid transition found');
    }

    // Check permissions
    if (!this.checkPermissions(transition.permissions, request.userId)) {
      throw new BadRequestException('Insufficient permissions');
    }

    // Execute transition
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const oldState = instance.currentState;
      const newState = transition.toState;

      // Update context
      const newContext = {
        ...instance.context,
        ...request.context,
      };

      // Add to history
      instance.history.push({
        timestamp: new Date(),
        fromState: oldState.name,
        toState: newState.name,
        transitionId: transition.id,
        triggeredBy: request.userId,
        context: newContext,
      });

      // Calculate new SLA deadline
      let slaDeadline: Date | null = null;
      if (instance.workflow.slaConfig?.enabled && newState.config?.slaHours) {
        slaDeadline = new Date();
        slaDeadline.setHours(slaDeadline.getHours() + newState.config.slaHours);
      }

      // Check if this is an end state
      const newStatus =
        newState.type === StateType.END
          ? InstanceStatus.COMPLETED
          : InstanceStatus.ACTIVE;

      await queryRunner.manager.update(WorkflowInstance, instance.id, {
        currentStateId: newState.id,
        status: newStatus,
        context: newContext,
        history: instance.history,
        stateEnteredAt: new Date(),
        slaDeadline,
        escalationLevel: 0,
        completedAt: newStatus === InstanceStatus.COMPLETED ? new Date() : null,
      });

      await queryRunner.commitTransaction();

      // Execute actions
      await this.executeActions(transition.actions, instance);

      this.logger.log(
        `Transition executed: ${instance.id} (${oldState.name} -> ${newState.name})`,
      );

      return this.getInstance(instance.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ==================== SLA MONITORING ====================

  async checkSLAViolations(): Promise<void> {
    const now = new Date();
    const violations = await this.instanceRepo.find({
      where: {
        status: InstanceStatus.ACTIVE,
        slaDeadline: now,
      },
      relations: ['workflow', 'currentState'],
    });

    for (const instance of violations) {
      const escalationLevel = instance.escalationLevel + 1;
      const escalation = instance.workflow.slaConfig?.escalationLevels?.find(
        (e) => e.level === escalationLevel,
      );

      if (escalation) {
        // Execute escalation action
        this.logger.warn(
          `SLA violation for instance ${instance.id}: Level ${escalationLevel}`,
        );

        instance.slaViolations.push({
          level: escalationLevel,
          timestamp: new Date(),
          action: escalation.action,
        });

        // Update escalation level
        await this.instanceRepo.update(instance.id, {
          escalationLevel,
          slaViolations: instance.slaViolations,
        });

        // TODO: Send notifications based on escalation.notify
      }
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private evaluateConditions(
    conditions: { operator: string; rules: any[] },
    context: Record<string, any>,
  ): boolean {
    if (!conditions.rules || conditions.rules.length === 0) {
      return true;
    }

    const results = conditions.rules.map((rule) => {
      const value = context[rule.field];
      switch (rule.operator) {
        case 'equals':
          return value === rule.value;
        case 'not_equals':
          return value !== rule.value;
        case 'greater_than':
          return value > rule.value;
        case 'less_than':
          return value < rule.value;
        case 'contains':
          return value?.includes(rule.value);
        case 'in':
          return rule.value?.includes(value);
        default:
          return true;
      }
    });

    return conditions.operator === 'AND'
      ? results.every((r) => r)
      : results.some((r) => r);
  }

  private checkPermissions(
    permissions: { roles?: string[]; users?: string[] },
    userId: string,
  ): boolean {
    // Simplified permission check - in production, check user roles
    if (!permissions.roles?.length && !permissions.users?.length) {
      return true;
    }
    if (permissions.users?.includes(userId)) {
      return true;
    }
    return false;
  }

  private async executeActions(
    actions: Array<{ type: string; config: Record<string, any> }>,
    instance: WorkflowInstance,
  ): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'notification':
            this.logger.log(`Sending notification: ${action.config.message}`);
            break;
          case 'webhook':
            this.logger.log(`Calling webhook: ${action.config.url}`);
            break;
          case 'task':
            this.logger.log(`Creating task: ${action.config.title}`);
            break;
          default:
            this.logger.log(`Action type ${action.type} not implemented`);
        }
      } catch (error) {
        this.logger.error(`Failed to execute action: ${action.type}`, error);
      }
    }
  }

  // ==================== SEARCH & AI INTEGRATION ====================

  async indexWorkflowInstance(instance: WorkflowInstance): Promise<void> {
    try {
      const searchableData = {
        tenantId: instance.tenantId,
        searchableType: 'workflow_instance',
        searchableId: instance.id,
        title: `Workflow: ${instance.workflow?.name || 'Unknown'}`,
        content: `Entity ${instance.entityType} ${instance.entityId} - Status: ${instance.status} - Current State: ${instance.currentState?.name || 'Unknown'}`,
        metadata: {
          workflowId: instance.workflowId,
          entityId: instance.entityId,
          entityType: instance.entityType,
          status: instance.status,
          currentState: instance.currentState?.name,
          context: instance.context,
        },
      };

      await this.searchService.indexEntityData(searchableData);
      this.logger.debug(`Workflow instance indexed: ${instance.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to index workflow instance: ${instance.id}`,
        error,
      );
    }
  }

  async searchWorkflowInstances(
    tenantId: string,
    query: string,
    limit: number = 20,
  ): Promise<any[]> {
    return this.searchService.search(tenantId, query, limit);
  }

  async getWorkflowRecommendations(
    tenantId: string,
    entityType: string,
    context: Record<string, any>,
  ): Promise<any> {
    try {
      const workflows = await this.listWorkflows(tenantId, entityType);

      const recommendation = await this.aiService.execute({
        category: 'workflow_decision' as any,
        key: 'workflow_recommendation',
        input: JSON.stringify({
          entityType,
          context,
          availableWorkflows: workflows.map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
          })),
        }),
        context: { tenantId },
      });

      return {
        success: true,
        recommendation: JSON.parse(recommendation.result),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get workflow recommendations: ${error.message}`,
      );
      return {
        success: false,
        recommendation: null,
        error: error.message,
      };
    }
  }

  async analyzeWorkflowPerformance(
    workflowId: string,
    tenantId: string,
  ): Promise<any> {
    try {
      const instances = await this.instanceRepo.find({
        where: { workflowId, tenantId },
      });

      const analysis = await this.aiService.execute({
        category: 'data_extraction' as any,
        key: 'workflow_analysis',
        input: JSON.stringify({
          totalInstances: instances.length,
          completedInstances: instances.filter(
            (i) => i.status === InstanceStatus.COMPLETED,
          ).length,
          averageCompletionTime: this.calculateAverageCompletionTime(instances),
          slaViolations: instances.reduce(
            (sum, i) => sum + (i.slaViolations?.length || 0),
            0,
          ),
        }),
        context: { tenantId },
      });

      return JSON.parse(analysis.result);
    } catch (error) {
      this.logger.error(
        `Failed to analyze workflow performance: ${error.message}`,
      );
      return null;
    }
  }

  private calculateAverageCompletionTime(
    instances: WorkflowInstance[],
  ): number {
    const completedInstances = instances.filter(
      (i) =>
        i.status === InstanceStatus.COMPLETED && i.completedAt && i.createdAt,
    );

    if (completedInstances.length === 0) return 0;

    const totalTime = completedInstances.reduce((sum, instance) => {
      const completionTime =
        new Date(instance.completedAt!).getTime() -
        new Date(instance.createdAt).getTime();
      return sum + completionTime;
    }, 0);

    return Math.round(totalTime / completedInstances.length / (1000 * 60 * 60)); // Return hours
  }

  // ==================== DOCUMENT INTEGRATION ====================

  async getWorkflowDocuments(
    tenantId: string,
    workflowInstanceId: string,
  ): Promise<Document[]> {
    return this.documentHubService.getWorkflowDocuments(
      tenantId,
      workflowInstanceId,
    );
  }

  async attachDocumentToWorkflow(
    tenantId: string,
    workflowInstanceId: string,
    documentId: string,
    userId: string,
  ): Promise<Document> {
    const instance = await this.getInstance(workflowInstanceId);

    if (instance.tenantId !== tenantId) {
      throw new BadRequestException('Access denied');
    }

    return this.documentHubService.attachDocumentToEntity(
      documentId,
      'workflow_instance',
      workflowInstanceId,
      userId,
    );
  }

  async processDocumentsWithAI(
    workflowInstanceId: string,
    documentIds: string[],
    extractionSchema: Record<string, any>,
  ): Promise<any> {
    const instance = await this.getInstance(workflowInstanceId);

    const results = await Promise.all(
      documentIds.map(async (docId) => {
        try {
          return await this.documentHubService.extractDocumentData(
            docId,
            extractionSchema,
          );
        } catch (error) {
          this.logger.error(`Failed to process document ${docId}:`, error);
          return { documentId: docId, success: false, error: error.message };
        }
      }),
    );

    // Update workflow context with extracted data
    const extractedData = results
      .filter((r) => r.success)
      .reduce((acc, r) => ({ ...acc, ...r.extractedData }), {});

    instance.context = {
      ...instance.context,
      extractedDocuments: results,
      extractedData,
    };

    await this.instanceRepo.save(instance);

    return {
      workflowInstanceId,
      processedDocuments: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      extractedData,
    };
  }

  async searchWorkflowDocuments(
    tenantId: string,
    workflowInstanceId: string,
    query: string,
  ): Promise<any[]> {
    return this.documentHubService.searchDocuments(tenantId, query, {
      entityType: 'workflow_instance',
      entityId: workflowInstanceId,
    });
  }
}
