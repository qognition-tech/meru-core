import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

export enum AgentRunStatus {
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * One execution of an autonomous agent.
 *
 * The agents themselves are code (the specialist engines of CLAUDE.md §3 and
 * the scheduled services), so there is no "agents" table — a registry of code
 * that already exists would drift the moment someone added an engine. What
 * cannot be derived from code is *history*: when it last ran, whether it
 * worked, how often it fails. That is this table, and it is what the Agents
 * page actually renders.
 */
@Entity('agent_runs')
@Index(['tenantId'])
@Index(['tenantId', 'agentId'])
@Index(['tenantId', 'agentId', 'startedAt'])
export class AgentRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  /** Stable slug from the registry, e.g. `regulatory-radar`. */
  @Column({ length: 64 })
  agentId: string;

  @Column({
    type: 'enum',
    enum: AgentRunStatus,
    default: AgentRunStatus.RUNNING,
  })
  status: AgentRunStatus;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  /** Human-readable outcome — the message the Agents page shows as a log line. */
  @Column({ type: 'text', nullable: true })
  message: string | null;

  /**
   * `users.id` when a person pressed Run, null when the scheduler fired it.
   * Distinguishing the two is the whole point of an audit trail on automation.
   */
  @Column({ type: 'uuid', nullable: true })
  triggeredBy: string | null;

  @Column({ type: 'jsonb', default: {} })
  result: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
