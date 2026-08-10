import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { NotificationsService } from './notifications.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant, TenantStatus } from '../iam/entities/tenant.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { TenantContext } from '../core/tenancy/tenant-context';

/** One `messaging.sequences[]` entry, as the pack declares it. */
export interface SequenceDefinition {
  key: string;
  label: string;
  trigger: { entityType: string; when: unknown };
  steps: Array<{ templateKey: string; afterHours?: number; when?: unknown }>;
  stopWhen?: unknown;
  stopOnReply?: boolean;
  maxMessages?: number;
}

export interface SequenceRunSummary {
  tenantsScanned: number;
  sequencesEvaluated: number;
  enrolled: number;
  sent: number;
  stopped: number;
  /**
   * Messages that went out with `{{placeholders}}` still in them, and which
   * ones. A pack authoring error rather than a code fault — the template
   * declares a variable the runner has no way to supply — but it reaches a
   * client, so it is reported rather than logged and forgotten.
   */
  unrenderedVariables: Array<{
    sequenceKey: string;
    templateKey: string;
    variables: string[];
  }>;
  invalidSequences: Array<{
    tenantId: string;
    sequenceKey: string;
    reason: string;
  }>;
}

/** Same reasoning as the alert sweep: one tenant's data volume must not starve the rest. */
const MAX_ENTITIES_PER_SEQUENCE = 2_000;

/**
 * Multi-step outbound messaging, driven entirely by the pack.
 *
 * Payment reminders, RFI follow-ups, document chasers, onboarding nurture,
 * newsletters — eight separately-named features across the two specs that are
 * one state machine (docs/FEATURE_PARITY_MAP.md §5, item 4). Core supplies the
 * machine; the vertical supplies the trigger, the steps and the words.
 */
@Injectable()
export class SequenceRunnerService {
  private readonly logger = new Logger(SequenceRunnerService.name);

  constructor(
    @InjectRepository(SequenceEnrolment)
    private readonly enrolmentRepo: Repository<SequenceEnrolment>,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly evaluator: RuleEvaluatorService,
    private readonly packs: VerticalPackService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Enrol newly-matching records and send whatever steps are now due.
   *
   * Tenant enumeration runs as system because crossing tenants is the job;
   * each tenant's work is then bound to that tenant so the database enforces
   * isolation (CLAUDE.md §6.4).
   */
  async run(now: Date = new Date()): Promise<SequenceRunSummary> {
    const summary: SequenceRunSummary = {
      tenantsScanned: 0,
      sequencesEvaluated: 0,
      enrolled: 0,
      sent: 0,
      stopped: 0,
      unrenderedVariables: [],
      invalidSequences: [],
    };

    const tenants = await TenantContext.runAsSystem(
      'sequence runner: enumerate tenants',
      () =>
        this.tenantRepo.find({
          where: { status: In([TenantStatus.ACTIVE, TenantStatus.TRIAL]) },
        }),
    );

    for (const tenant of tenants) {
      const messaging = await TenantContext.runAsSystem(
        'sequence runner: read pack',
        () =>
          this.packs.section<{ sequences?: SequenceDefinition[] }>(
            tenant.vertical,
            'messaging',
          ),
      );

      const sequences = messaging?.sequences ?? [];
      if (!sequences.length) continue;
      summary.tenantsScanned++;

      await TenantContext.run({ tenantId: tenant.id }, async () => {
        for (const sequence of sequences) {
          await this.runSequence(tenant, sequence, now, summary);
        }
      });
    }

    this.logger.log(
      `Sequence run: ${summary.tenantsScanned} tenants, ` +
        `${summary.sequencesEvaluated} sequences → enrolled ${summary.enrolled}, ` +
        `sent ${summary.sent}, stopped ${summary.stopped}`,
    );

    return summary;
  }

  private async runSequence(
    tenant: Tenant,
    sequence: SequenceDefinition,
    now: Date,
    summary: SequenceRunSummary,
  ): Promise<void> {
    // Validate every condition the sequence carries before it can enrol
    // anybody. A trigger that cannot compile would otherwise throw mid-sweep;
    // a stop condition that cannot compile is worse, because the sequence
    // would enrol correctly and then never stop.
    for (const [label, condition] of [
      ['trigger.when', sequence.trigger?.when],
      ['stopWhen', sequence.stopWhen],
      ...sequence.steps.map(
        (s, i) => [`steps[${i}].when`, s.when] as [string, unknown],
      ),
    ] as Array<[string, unknown]>) {
      if (condition === undefined || condition === null) continue;
      const check = this.evaluator.validate(condition);
      if (!check.valid) {
        summary.invalidSequences.push({
          tenantId: tenant.id,
          sequenceKey: sequence.key,
          reason: `${label}: ${check.reason}`,
        });
        this.logger.error(
          `Sequence '${sequence.key}' (${tenant.vertical}) has an unevaluable ` +
            `${label} and was skipped: ${check.reason}`,
        );
        return;
      }
    }

    if (!sequence.steps.length) return;
    summary.sequencesEvaluated++;

    const entities = await this.entityRepo.find({
      where: {
        tenantId: tenant.id,
        type: sequence.trigger.entityType as UniversalEntity['type'],
        deletedAt: IsNull(),
      },
      take: MAX_ENTITIES_PER_SEQUENCE,
      order: { updatedAt: 'DESC' },
    });

    const enrolments = await this.enrolmentRepo.find({
      where: { tenantId: tenant.id, sequenceKey: sequence.key },
    });
    const byEntity = new Map(enrolments.map((e) => [e.entityId, e]));

    for (const entity of entities) {
      const data = entity as unknown as Record<string, unknown>;
      let enrolment = byEntity.get(entity.id);

      // A stopped enrolment is final. Re-enrolling on a later match would
      // restart a sequence someone was deliberately taken out of — including
      // one stopped because they replied.
      if (enrolment?.stoppedAt) continue;

      if (!enrolment) {
        if (!this.evaluator.matches(sequence.trigger.when, data)) continue;

        enrolment = this.enrolmentRepo.create({
          tenantId: tenant.id,
          sequenceKey: sequence.key,
          entityId: entity.id,
          entityType: entity.type,
          enrolledAt: now,
          stepsSent: 0,
          lastSentAt: null,
          stoppedAt: null,
          stopReason: null,
        });
        summary.enrolled++;
      }

      const stop = this.stopReasonFor(sequence, enrolment, data);
      if (stop) {
        enrolment.stoppedAt = now;
        enrolment.stopReason = stop;
        await this.enrolmentRepo.save(enrolment);
        summary.stopped++;
        continue;
      }

      await this.sendDueSteps(tenant, sequence, enrolment, entity, now, summary);
      await this.enrolmentRepo.save(enrolment);
    }
  }

  /**
   * Why this enrolment should end, or null to continue.
   *
   * Checked before every send, not only at enrolment: the whole hazard of
   * automated messaging is continuing to ask someone for something they have
   * already done, which is the single most reliable way to damage a client
   * relationship with software.
   */
  private stopReasonFor(
    sequence: SequenceDefinition,
    enrolment: SequenceEnrolment,
    data: Record<string, unknown>,
  ): string | null {
    if (sequence.stopWhen && this.evaluator.matches(sequence.stopWhen, data)) {
      return 'stop_condition';
    }

    // The trigger no longer holding is itself a stop condition. A document
    // chaser must stop when the document arrives even if the pack author
    // forgot to write `stopWhen` — the trigger already encodes "still needs
    // chasing".
    if (!this.evaluator.matches(sequence.trigger.when, data)) {
      return 'trigger_cleared';
    }

    if (sequence.stopOnReply !== false && this.hasRepliedSince(data, enrolment)) {
      return 'replied';
    }

    const max = sequence.maxMessages ?? 5;
    if (enrolment.stepsSent >= Math.min(max, sequence.steps.length)) {
      return enrolment.stepsSent >= max ? 'max_messages' : 'completed';
    }

    return null;
  }

  /**
   * Whether the recipient answered since enrolling.
   *
   * Honest limitation: COM is a one-way delivery log with no inbound channel
   * and no thread key, so nothing in this system currently sets `repliedAt`.
   * The check reads a `repliedAt` / `lastInboundAt` attribute so that whatever
   * lands first — an inbound webhook, an IMAP poller, a portal reply — makes
   * `stopOnReply` work without touching this file. Until then the flag is
   * declared and inert, and saying so is better than implying a guard that
   * does not exist.
   */
  private hasRepliedSince(
    data: Record<string, unknown>,
    enrolment: SequenceEnrolment,
  ): boolean {
    const attrs = (data.verticalAttributes ?? {}) as Record<string, unknown>;
    const raw = attrs.repliedAt ?? attrs.lastInboundAt;
    if (typeof raw !== 'string' && !(raw instanceof Date)) return false;

    const repliedAt = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(repliedAt.getTime())) return false;

    return repliedAt.getTime() > enrolment.enrolledAt.getTime();
  }

  /**
   * Send every step whose delay has elapsed.
   *
   * Delays are measured from enrolment rather than from the previous send, so
   * a sweep that does not run for a day does not push the entire remaining
   * schedule a day later — it catches up. That also means a long outage can
   * make two steps due at once, which is why sending is capped by
   * `maxMessages` here and not only in the stop check.
   */
  private async sendDueSteps(
    tenant: Tenant,
    sequence: SequenceDefinition,
    enrolment: SequenceEnrolment,
    entity: UniversalEntity,
    now: Date,
    summary: SequenceRunSummary,
  ): Promise<void> {
    const max = sequence.maxMessages ?? 5;
    const elapsedHours =
      (now.getTime() - enrolment.enrolledAt.getTime()) / 3_600_000;

    for (let i = enrolment.stepsSent; i < sequence.steps.length; i++) {
      if (enrolment.stepsSent >= max) break;

      const step = sequence.steps[i];
      if (elapsedHours < (step.afterHours ?? 0)) break;

      const data = entity as unknown as Record<string, unknown>;
      if (step.when && !this.evaluator.matches(step.when, data)) {
        // A step whose own condition fails is skipped, not deferred —
        // otherwise one unmet condition stalls the rest of the sequence
        // forever.
        enrolment.stepsSent = i + 1;
        continue;
      }

      const sent = await this.send(tenant, sequence, step, entity, summary);
      enrolment.stepsSent = i + 1;
      if (sent) {
        enrolment.lastSentAt = now;
        summary.sent++;
      }
    }

    if (enrolment.stepsSent >= Math.min(max, sequence.steps.length)) {
      enrolment.stoppedAt = now;
      enrolment.stopReason =
        enrolment.stepsSent >= max ? 'max_messages' : 'completed';
      summary.stopped++;
    }
  }

  private async send(
    tenant: Tenant,
    sequence: SequenceDefinition,
    step: { templateKey: string },
    entity: UniversalEntity,
    summary: SequenceRunSummary,
  ): Promise<boolean> {
    const attrs = entity.verticalAttributes ?? {};
    const variables = {
      ...attrs,
      firstName: entity.firstName ?? '',
      lastName: entity.lastName ?? '',
      // Every client-facing template in both packs greets on behalf of the
      // firm, and the firm is the tenant — so this is always available and
      // there is no reason to make a pack author carry it in every record.
      firmName: tenant.name ?? '',
      entityId: entity.id,
      entityType: entity.type,
      dueDate: entity.dueDate?.toISOString() ?? '',
    };

    try {
      const notification = await this.notifications.sendFromTemplate(
        tenant.id,
        step.templateKey,
        // The recipient is a CRM record, not a platform user, so its id goes
        // in `recipientId` and the address travels with it — see the options
        // note on sendFromTemplate.
        entity.id,
        variables,
        tenant.vertical,
        {
          recipientEmail:
            entity.email ??
            (typeof attrs.email === 'string' ? attrs.email : null),
          metadata: {
            sequenceKey: sequence.key,
            templateKey: step.templateKey,
            entityId: entity.id,
          },
        },
      );

      // Rendering leaves an unknown `{{placeholder}}` in place. That is the
      // right behaviour for the renderer — dropping it silently would hide the
      // gap — but it means a client can receive literal `{{uploadUrl}}`. The
      // sequence cannot know every variable a template wants, so the mismatch
      // is surfaced here instead of discovered by a recipient.
      const unresolved = this.unresolvedIn(notification?.content, notification?.subject);
      if (unresolved.length) {
        summary.unrenderedVariables.push({
          sequenceKey: sequence.key,
          templateKey: step.templateKey,
          variables: unresolved,
        });
        this.logger.error(
          `Sequence '${sequence.key}' sent template '${step.templateKey}' with ` +
            `unrendered variables: ${unresolved.join(', ')} — the template ` +
            `declares variables the sequence runner cannot supply.`,
        );
      }

      return true;
    } catch (err) {
      // One undeliverable message must not stall the enrolment or abandon the
      // tenants queued behind this one. The step still counts as attempted, so
      // a permanently-bad address cannot loop forever.
      this.logger.error(
        `Sequence '${sequence.key}' step '${step.templateKey}' failed for ` +
          `entity ${entity.id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  /** `{{placeholders}}` still present after rendering, deduplicated. */
  private unresolvedIn(...parts: Array<string | undefined>): string[] {
    const found = new Set<string>();
    for (const part of parts) {
      if (!part) continue;
      for (const match of part.matchAll(/{{(\w+)}}/g)) found.add(match[1]);
    }
    return [...found];
  }

  /** Active enrolments for a tenant — what a sequences page renders. */
  async listActive(tenantId: string, limit = 200): Promise<SequenceEnrolment[]> {
    return this.enrolmentRepo.find({
      where: { tenantId, stoppedAt: IsNull() },
      order: { enrolledAt: 'DESC' },
      take: limit,
    });
  }
}
