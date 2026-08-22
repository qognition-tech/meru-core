import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow, WorkflowStatus, WorkflowTrigger } from '../entities/workflow.entity';
import { StateType } from '../entities/workflow-state.entity';
import { TransitionType } from '../entities/workflow-transition.entity';
import { WorkflowEngineService, WorkflowDefinition } from '../workflow.service';
import { VerticalPackService } from '../../tenant/services/vertical-pack.service';
import { compileCondition } from './pack-condition';

/** `workflows[]` entry of a pack — see `WorkflowStepSchema` in pack.schema.ts. */
export interface PackWorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  entityType: string;
  steps: Array<{
    id: string;
    name: string;
    description?: string;
    type: string;
    assignedRole?: string;
    slaHours?: number;
    formFields?: unknown[];
    requiredDocuments?: string[];
    apiAction?: unknown;
    transitions?: Array<{ to: string; label: string; condition?: string }>;
  }>;
}

export interface MaterialiseReport {
  pack: { code: string; version: string } | null;
  created: { packWorkflowId: string; workflowId: string }[];
  existing: { packWorkflowId: string; workflowId: string }[];
  /** Transitions whose `condition` did not compile. They exist but never open. */
  unevaluableConditions: {
    packWorkflowId: string;
    from: string;
    to: string;
    reason: string;
  }[];
}

/**
 * Turns a pack's `workflows[]` into `workflows` / `workflow_states` /
 * `workflow_transitions` rows for one tenant.
 *
 * Until this existed the pack's workflows were inert end to end: validated,
 * stored, served to the UI as JSON, and never instantiable — there was no
 * `workflows` row for `startWorkflow` to start. This is the largest gap the
 * immigration vertical had (CLAUDE.md §16).
 *
 * Idempotent per tenant and pack workflow id: the origin is recorded on
 * `triggerConfig.pack`, and a second call finds rather than duplicates. A
 * pack version bump does not rewrite a materialised workflow — running
 * instances point at its states — it reports `existing`; re-materialising
 * under a new version is deliberate operator work, not a side effect.
 *
 * Step → state: the first step is START, a step with no outgoing transition
 * is END, everything else INTERMEDIATE. Each step's transitions become
 * CONDITIONAL transitions when they carry a `condition`, MANUAL otherwise.
 * The condition is compiled to JsonLogic by `compileCondition`; one that
 * cannot compile is stored with `unevaluable` set and is never available —
 * a transition nobody can take is a visible, fixable authoring error, while
 * one that opens by default is a silent wrong answer.
 */
@Injectable()
export class PackWorkflowService {
  private readonly logger = new Logger(PackWorkflowService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    private readonly engine: WorkflowEngineService,
    private readonly packs: VerticalPackService,
  ) {}

  /** The pack's workflow definitions, as authored. */
  async list(vertical: string | null): Promise<PackWorkflowDefinition[]> {
    return this.packs.list<PackWorkflowDefinition>(vertical, 'workflows');
  }

  async materialise(
    tenantId: string,
    vertical: string | null,
    userId: string,
    onlyPackWorkflowId?: string,
  ): Promise<MaterialiseReport> {
    const { pack, section } = await this.packs.sectionWithPack<
      PackWorkflowDefinition[]
    >(vertical, 'workflows');
    const report: MaterialiseReport = {
      pack: pack ? { code: pack.code, version: pack.version } : null,
      created: [],
      existing: [],
      unevaluableConditions: [],
    };
    const defs = (Array.isArray(section) ? section : []).filter(
      (d) => !onlyPackWorkflowId || d.id === onlyPackWorkflowId,
    );

    for (const def of defs) {
      const found = await this.findMaterialised(tenantId, def.id);
      if (found) {
        report.existing.push({ packWorkflowId: def.id, workflowId: found.id });
        continue;
      }

      const definition = this.toDefinition(def, report, pack?.code ?? null, pack?.version ?? null);
      const workflow = await this.engine.createWorkflow(tenantId, definition, userId);
      // A pack workflow is authored and reviewed; it is usable on arrival.
      await this.workflowRepo.update(workflow.id, { status: WorkflowStatus.ACTIVE });
      report.created.push({ packWorkflowId: def.id, workflowId: workflow.id });
      this.logger.log(
        `Materialised pack workflow '${def.id}' for tenant ${tenantId} as ${workflow.id}`,
      );
    }

    return report;
  }

  private async findMaterialised(
    tenantId: string,
    packWorkflowId: string,
  ): Promise<Workflow | null> {
    return this.workflowRepo
      .createQueryBuilder('w')
      .where('w."tenantId" = :tenantId', { tenantId })
      .andWhere(`w."triggerConfig"->'pack'->>'workflowId' = :packWorkflowId`, {
        packWorkflowId,
      })
      .orderBy('w.version', 'DESC')
      .getOne();
  }

  private toDefinition(
    def: PackWorkflowDefinition,
    report: MaterialiseReport,
    packCode: string | null,
    packVersion: string | null,
  ): WorkflowDefinition {
    const hasOutgoing = new Set(
      def.steps
        .filter((s) => (s.transitions ?? []).length > 0)
        .map((s) => s.id),
    );

    const states: WorkflowDefinition['states'] = def.steps.map((step, i) => ({
      name: step.id,
      type:
        i === 0
          ? StateType.START
          : hasOutgoing.has(step.id)
            ? StateType.INTERMEDIATE
            : StateType.END,
      description: step.description ?? step.name,
      config: {
        label: step.name,
        stepType: step.type,
        assignedRole: step.assignedRole ?? null,
        slaHours: step.slaHours ?? null,
        formFields: step.formFields ?? [],
        requiredDocuments: step.requiredDocuments ?? [],
        apiAction: step.apiAction ?? null,
      },
    }));

    const transitions: WorkflowDefinition['transitions'] = [];
    for (const step of def.steps) {
      for (const t of step.transitions ?? []) {
        const compiled = compileCondition(t.condition);
        const conditions: Record<string, unknown> = {
          operator: 'AND',
          rules: [],
        };
        if (compiled.ok) {
          if (t.condition && t.condition.trim()) {
            conditions.jsonLogic = compiled.compiled.jsonLogic;
            conditions.source = compiled.compiled.source;
          }
        } else {
          conditions.unevaluable = compiled.reason;
          conditions.source = t.condition;
          report.unevaluableConditions.push({
            packWorkflowId: def.id,
            from: step.id,
            to: t.to,
            reason: compiled.reason,
          });
          this.logger.error(
            `Pack workflow '${def.id}' transition ${step.id} → ${t.to} has an ` +
              `unevaluable condition and will never open: ${compiled.reason}`,
          );
        }
        transitions.push({
          name: t.label,
          from: step.id,
          to: t.to,
          type: t.condition ? TransitionType.CONDITIONAL : TransitionType.MANUAL,
          conditions,
          actions: [],
          permissions: step.assignedRole ? { roles: [step.assignedRole] } : {},
        });
      }
    }

    return {
      name: def.name,
      description: def.description,
      entityType: def.entityType,
      states,
      transitions,
      trigger: WorkflowTrigger.MANUAL,
      triggerConfig: {
        pack: { code: packCode, version: packVersion, workflowId: def.id },
      } as WorkflowDefinition['triggerConfig'],
      slaConfig: { enabled: def.steps.some((s) => s.slaHours) },
    };
  }
}
