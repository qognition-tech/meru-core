import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRun, AgentRunStatus } from './entities/agent-run.entity';
import { RegulatoryRadarEngine } from '../ai/engines/regulatory-radar.engine';
import { SlaWatchdogService } from '../workflow/services/sla-watchdog.service';

/**
 * What an agent is, as far as the API is concerned.
 *
 * `run` is optional: some agents are reactive (they act on an event or a
 * request) rather than something you can press a button on. Advertising a Run
 * control for those and then silently doing nothing would be worse than
 * saying so — `runnable: false` lets the UI grey the button honestly.
 */
export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  /** Human-readable cadence, or 'Manual'/'On demand'. */
  schedule: string;
  /** Lucide icon name the portals already use. */
  icon: string;
  runnable: boolean;
  run?: (tenantId: string) => Promise<Record<string, any>>;
}

@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepo: Repository<AgentRun>,
    private readonly regulatoryRadar: RegulatoryRadarEngine,
    private readonly slaWatchdog: SlaWatchdogService,
  ) {}

  /**
   * The agents that actually exist in this codebase.
   *
   * Deliberately hand-written rather than reflected off the DI container: an
   * agent is a thing with a schedule, an owner and a meaning, not merely any
   * injectable whose name ends in "Engine". Adding one here is a conscious act.
   */
  private descriptors(): AgentDescriptor[] {
    return [
      {
        id: 'regulatory-radar',
        name: 'Regulatory Radar',
        description:
          'Crawls official government sources for rule changes and drafts ' +
          'config-pack diffs for human review (CLAUDE.md §3.1).',
        schedule: 'Daily at 01:00',
        icon: 'Radar',
        runnable: true,
        run: async () => {
          const result = await this.regulatoryRadar.runScan();
          return {
            sourcesScanned: result.sourcesScanned,
            changesDetected: result.changesDetected,
            errors: result.errors,
          };
        },
      },
      {
        id: 'sla-watchdog',
        name: 'SLA Watchdog',
        description:
          'Escalates workflow instances that have breached or are about to ' +
          'breach their SLA.',
        schedule: 'Every 5 minutes',
        icon: 'AlarmClock',
        runnable: true,
        run: async () => {
          await this.slaWatchdog.checkSLAViolations();
          return {};
        },
      },
      {
        id: 'screening',
        name: 'Screening Engine',
        description:
          'Fuzzy sanctions, PEP and adverse-media matching — Jaro-Winkler, ' +
          'Levenshtein, Soundex and Arabic/Latin transliteration (§3.2).',
        schedule: 'On demand',
        icon: 'ShieldCheck',
        // Reactive: it screens a name you give it. There is nothing to "run"
        // without a subject, so the UI must not offer a bare Run button.
        runnable: false,
      },
      {
        id: 'doc-intel',
        name: 'Document Intelligence',
        description:
          'Multi-language OCR, layout-aware extraction and fraud-signal ' +
          'detection on submitted files (§3.3).',
        schedule: 'On upload',
        icon: 'FileSearch',
        runnable: false,
      },
      {
        id: 'vessel-tracking',
        name: 'Vessel Tracking',
        description:
          'AIS positions, sanctioned-port geofencing and dark-period ' +
          'detection for trade finance (§3.4).',
        schedule: 'On demand',
        icon: 'Ship',
        runnable: false,
      },
    ];
  }

  private descriptor(agentId: string): AgentDescriptor {
    const found = this.descriptors().find((a) => a.id === agentId);
    if (!found) throw new NotFoundException(`Unknown agent: ${agentId}`);
    return found;
  }

  /**
   * Every agent, enriched with this tenant's execution history.
   *
   * History is aggregated in two grouped queries rather than one per agent, so
   * the page costs the same whether there are five agents or fifty.
   */
  async listAgents(tenantId: string) {
    const descriptors = this.descriptors();

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [latest, todayStats] = await Promise.all([
      this.runRepo
        .createQueryBuilder('r')
        .distinctOn(['r."agentId"'])
        .where('r."tenantId" = :tenantId', { tenantId })
        .orderBy('r."agentId"')
        .addOrderBy('r."startedAt"', 'DESC')
        .getMany(),
      this.runRepo
        .createQueryBuilder('r')
        .select('r."agentId"', 'agentId')
        .addSelect('COUNT(*)::int', 'total')
        .addSelect(
          `COUNT(*) FILTER (WHERE r.status = 'success')::int`,
          'succeeded',
        )
        .where('r."tenantId" = :tenantId', { tenantId })
        .andWhere('r."startedAt" >= :since', { since })
        .groupBy('r."agentId"')
        .getRawMany<{ agentId: string; total: number; succeeded: number }>(),
    ]);

    const lastById = new Map(latest.map((r) => [r.agentId, r]));
    const statsById = new Map(todayStats.map((s) => [s.agentId, s]));

    return descriptors.map((d) => {
      const last = lastById.get(d.id);
      const stats = statsById.get(d.id);

      return {
        id: d.id,
        name: d.name,
        description: d.description,
        schedule: d.schedule,
        icon: d.icon,
        runnable: d.runnable,
        status: last?.status === AgentRunStatus.RUNNING ? 'running' : 'idle',
        lastRunAt: last?.startedAt ?? null,
        lastRunStatus: last?.status ?? null,
        executionsToday: stats?.total ?? 0,
        // No runs today is not a 0% success rate — it is an absence of
        // evidence. Reporting 0 would light up every agent as failing on a
        // quiet morning.
        successRate: stats?.total
          ? Math.round((stats.succeeded / stats.total) * 100)
          : 100,
      };
    });
  }

  /** Recent runs for one agent, newest first, shaped as log lines. */
  async getAgentLogs(tenantId: string, agentId: string, limit = 50) {
    this.descriptor(agentId); // 404s on an unknown id rather than returning []

    const runs = await this.runRepo.find({
      where: { tenantId, agentId },
      order: { startedAt: 'DESC' },
      take: Math.min(limit, 200),
    });

    return runs.map((r) => ({
      id: r.id,
      createdAt: r.startedAt,
      level:
        r.status === AgentRunStatus.FAILED
          ? 'error'
          : r.status === AgentRunStatus.RUNNING
            ? 'info'
            : 'success',
      message:
        r.message ??
        (r.status === AgentRunStatus.RUNNING
          ? `${agentId} started`
          : `${agentId} ${r.status}`),
      durationMs: r.durationMs,
      triggeredBy: r.triggeredBy,
    }));
  }

  /**
   * Run an agent now, recording the attempt either way.
   *
   * The run row is written *before* the work starts and updated after, so an
   * agent that crashes or is killed mid-flight still leaves evidence it was
   * attempted — the same reasoning as the god-mode audit entry.
   */
  async runAgent(tenantId: string, agentId: string, triggeredBy: string) {
    const descriptor = this.descriptor(agentId);

    if (!descriptor.runnable || !descriptor.run) {
      throw new NotFoundException(
        `Agent "${agentId}" is reactive and cannot be triggered directly`,
      );
    }

    const startedAt = new Date();
    const run = await this.runRepo.save(
      this.runRepo.create({
        tenantId,
        agentId,
        status: AgentRunStatus.RUNNING,
        startedAt,
        triggeredBy,
      }),
    );

    try {
      const result = await descriptor.run(tenantId);
      const finishedAt = new Date();

      await this.runRepo.update(run.id, {
        status: AgentRunStatus.SUCCESS,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        message: `${descriptor.name} completed`,
        result: result ?? {},
      });

      return { runId: run.id, agentId, status: 'success', result };
    } catch (error) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);

      await this.runRepo.update(run.id, {
        status: AgentRunStatus.FAILED,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        message,
      });

      this.logger.error(`Agent ${agentId} failed: ${message}`);

      // Reported as a completed request carrying a failed run, not a 500. The
      // API call succeeded — it ran the agent and the agent failed, which is a
      // result the page needs to display, not an error it should swallow.
      return { runId: run.id, agentId, status: 'failed', error: message };
    }
  }
}
