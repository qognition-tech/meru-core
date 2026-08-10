import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InstanceStatus,
  WorkflowInstance,
} from '../entities/workflow-instance.entity';

export interface StageTat {
  stage: string;
  enteredAt: string;
  exitedAt: string | null;
  hours: number;
  /** Null when the stage declares no SLA — unknown, not "met". */
  slaHours: number | null;
  breached: boolean | null;
  /** True while the record is still sitting in this stage. */
  open: boolean;
}

export interface InstanceTat {
  instanceId: string;
  workflowId: string;
  entityType: string;
  entityId: string;
  status: InstanceStatus;
  startedAt: string;
  completedAt: string | null;
  /** Wall-clock hours from start to completion, or to now if still running. */
  totalHours: number;
  stages: StageTat[];
}

export interface StageAggregate {
  stage: string;
  entries: number;
  meanHours: number;
  medianHours: number;
  p90Hours: number;
  slaHours: number | null;
  breaches: number;
  /** Null when no stage entry had an SLA to breach. */
  breachRate: number | null;
}

/**
 * Turnaround time, derived rather than recorded.
 *
 * Every "TAT recording" requirement in both specs asks for the same thing: how
 * long did each stage take, and did it beat its SLA. `workflow_instances`
 * already holds an ordered `history` of transitions, and each entry's timestamp
 * is exactly the moment the previous stage ended — so the per-stage clock is
 * already in the database and nobody was reading it.
 *
 * Deriving beats adding a `stage_durations` table for one reason that matters
 * here: a recorded duration and a transition history can disagree, and when
 * they do there is no way to tell which is wrong. A derivation cannot drift
 * from its source. The cost is that TAT is only as granular as the history, and
 * instances that predate history-keeping report what they can rather than
 * guessing.
 */
@Injectable()
export class TatService {
  constructor(
    @InjectRepository(WorkflowInstance)
    private readonly instances: Repository<WorkflowInstance>,
  ) {}

  /** Per-stage timings for one instance. */
  async forInstance(tenantId: string, instanceId: string): Promise<InstanceTat> {
    const instance = await this.instances.findOne({
      where: { id: instanceId, tenantId },
      relations: ['currentState'],
    });

    if (!instance) {
      throw new NotFoundException(`No workflow instance ${instanceId}`);
    }

    return this.compute(instance);
  }

  /**
   * Stage timings aggregated across instances.
   *
   * Median and p90 are reported alongside the mean because a mean turnaround
   * is the number a single stalled case can move on its own, and "our average
   * is 12 days" is exactly the claim a regulator asks to see evidenced.
   */
  async aggregate(
    tenantId: string,
    options: { workflowId?: string; since?: Date; limit?: number } = {},
  ): Promise<{
    workflowId: string | null;
    instances: number;
    stages: StageAggregate[];
    overall: { meanHours: number; medianHours: number; p90Hours: number } | null;
  }> {
    const qb = this.instances
      .createQueryBuilder('i')
      .where('i."tenantId" = :tenantId', { tenantId })
      .orderBy('i."createdAt"', 'DESC')
      .take(Math.min(options.limit ?? 500, 2000));

    if (options.workflowId) {
      qb.andWhere('i."workflowId" = :workflowId', {
        workflowId: options.workflowId,
      });
    }
    if (options.since) {
      qb.andWhere('i."createdAt" >= :since', { since: options.since });
    }

    const rows = await qb.getMany();
    const computed = rows.map((r) => this.compute(r));

    const byStage = new Map<string, StageTat[]>();
    for (const instance of computed) {
      for (const stage of instance.stages) {
        // An open stage has not turned around yet. Counting it would drag every
        // average toward whatever is currently in progress.
        if (stage.open) continue;
        const list = byStage.get(stage.stage) ?? [];
        list.push(stage);
        byStage.set(stage.stage, list);
      }
    }

    const stages: StageAggregate[] = [...byStage.entries()]
      .map(([stage, entries]) => {
        const hours = entries.map((e) => e.hours);
        const withSla = entries.filter((e) => e.slaHours !== null);
        return {
          stage,
          entries: entries.length,
          meanHours: this.round(hours.reduce((a, b) => a + b, 0) / hours.length),
          medianHours: this.round(this.percentile(hours, 50)),
          p90Hours: this.round(this.percentile(hours, 90)),
          slaHours: entries.find((e) => e.slaHours !== null)?.slaHours ?? null,
          breaches: entries.filter((e) => e.breached === true).length,
          breachRate: withSla.length
            ? this.round(
                (entries.filter((e) => e.breached === true).length /
                  withSla.length) *
                  100,
              )
            : null,
        };
      })
      .sort((a, b) => b.meanHours - a.meanHours);

    const completed = computed
      .filter((c) => c.status === InstanceStatus.COMPLETED)
      .map((c) => c.totalHours);

    return {
      workflowId: options.workflowId ?? null,
      instances: computed.length,
      stages,
      overall: completed.length
        ? {
            meanHours: this.round(
              completed.reduce((a, b) => a + b, 0) / completed.length,
            ),
            medianHours: this.round(this.percentile(completed, 50)),
            p90Hours: this.round(this.percentile(completed, 90)),
          }
        : null,
    };
  }

  private compute(instance: WorkflowInstance): InstanceTat {
    const history = Array.isArray(instance.history) ? instance.history : [];
    const startedAt = instance.createdAt ?? new Date();
    const slaHours = instance.workflow?.slaConfig?.enabled
      ? (instance.currentState?.config?.slaHours ?? null)
      : null;

    const stages: StageTat[] = [];
    let cursor = new Date(startedAt);

    for (const entry of history) {
      const at = new Date(entry.timestamp);
      stages.push({
        stage: entry.fromState,
        enteredAt: cursor.toISOString(),
        exitedAt: at.toISOString(),
        hours: this.hoursBetween(cursor, at),
        slaHours: null,
        breached: null,
        open: false,
      });
      cursor = at;
    }

    // The stage the record is in now, still running.
    const currentName = instance.currentState?.name ?? 'current';
    const now = new Date();
    const isFinished =
      instance.status === InstanceStatus.COMPLETED ||
      instance.status === InstanceStatus.CANCELLED;

    if (!isFinished) {
      const openHours = this.hoursBetween(
        instance.stateEnteredAt ?? cursor,
        now,
      );
      stages.push({
        stage: currentName,
        enteredAt: (instance.stateEnteredAt ?? cursor).toISOString(),
        exitedAt: null,
        hours: openHours,
        slaHours,
        // An open stage past its SLA has breached; one still inside it has not
        // *yet*, which is not the same as having met it — so `false` here means
        // "not breached so far", and the `open` flag is what says so.
        breached: slaHours === null ? null : openHours > slaHours,
        open: true,
      });
    }

    const end = isFinished ? (instance.completedAt ?? cursor) : now;

    return {
      instanceId: instance.id,
      workflowId: instance.workflowId,
      entityType: instance.entityType,
      entityId: instance.entityId,
      status: instance.status,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: instance.completedAt
        ? new Date(instance.completedAt).toISOString()
        : null,
      totalHours: this.hoursBetween(startedAt, end),
      stages,
    };
  }

  private hoursBetween(from: Date | string, to: Date | string): number {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return this.round(Math.max(ms, 0) / 3_600_000);
  }

  /** Nearest-rank percentile — no interpolation, so every value is a real one. */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
