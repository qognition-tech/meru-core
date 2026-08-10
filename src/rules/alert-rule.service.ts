import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { AlertFiring } from './entities/alert-firing.entity';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant, TenantStatus } from '../iam/entities/tenant.entity';
import { User, UserStatus } from '../iam/entities/user.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskService } from '../tasks/task.service';
import {
  NotificationCategory,
  NotificationPriority,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { TaskPriority, TaskType } from '../tasks/entities/task.entity';
import { TenantContext } from '../core/tenancy/tenant-context';

/** One `alertRules[]` entry, as the pack declares it. */
export interface AlertRuleDefinition {
  key: string;
  label: string;
  entityType: string;
  when: unknown;
  severity?: 'info' | 'warning' | 'critical';
  templateKey?: string;
  notifyRoles?: string[];
  createTask?: boolean;
  escalateAfterHours?: number | null;
  escalateToRoles?: string[];
  cooldownHours?: number;
}

export interface AlertSweepSummary {
  tenantsScanned: number;
  rulesEvaluated: number;
  entitiesScanned: number;
  /** Conditions that became true on this pass. */
  opened: number;
  /** Still true, and past their cooldown, so a notification went out. */
  notified: number;
  /** Still true past `escalateAfterHours`, escalated once. */
  escalated: number;
  /** Conditions that stopped being true. */
  resolved: number;
  tasksCreated: number;
  /** Rules refused at validation, with the reason. Never silently skipped. */
  invalidRules: Array<{ tenantId: string; ruleKey: string; reason: string }>;
}

/**
 * Cap per rule per pass. A tenant with 200k entities and a badly-authored rule
 * would otherwise hold the sweep for the entire function budget and starve
 * every tenant after it in the loop — the failure mode where one customer's
 * data volume silently disables a compliance feature for everybody else.
 */
const MAX_ENTITIES_PER_RULE = 2_000;

/**
 * "Tell someone when X becomes true", once, for every vertical.
 *
 * Visa expiry warnings, turnover thresholds, obligation deadlines, overdue
 * payments, SLA breaches, document expiry — nine separately-named features
 * across the GovX and immigration specs that are one loop over entities with a
 * predicate and a notification (docs/FEATURE_PARITY_MAP.md §5, item 2). Core
 * has no idea what a visa is; the pack supplies the predicate and the words.
 */
@Injectable()
export class AlertRuleService {
  private readonly logger = new Logger(AlertRuleService.name);

  constructor(
    @InjectRepository(AlertFiring)
    private readonly firingRepo: Repository<AlertFiring>,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly evaluator: RuleEvaluatorService,
    private readonly packs: VerticalPackService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TaskService,
  ) {}

  /**
   * Evaluate every tenant's alert rules.
   *
   * Tenant enumeration runs as system — a background sweep has no request
   * context and crossing tenants is the entire job. Each tenant's own work
   * then runs *bound to that tenant*, so RLS is the isolation boundary rather
   * than a WHERE clause the next edit could drop (CLAUDE.md §6.4).
   */
  async sweep(now: Date = new Date()): Promise<AlertSweepSummary> {
    const summary: AlertSweepSummary = {
      tenantsScanned: 0,
      rulesEvaluated: 0,
      entitiesScanned: 0,
      opened: 0,
      notified: 0,
      escalated: 0,
      resolved: 0,
      tasksCreated: 0,
      invalidRules: [],
    };

    const tenants = await TenantContext.runAsSystem(
      'alert rule sweep: enumerate tenants',
      () =>
        this.tenantRepo.find({
          where: { status: In([TenantStatus.ACTIVE, TenantStatus.TRIAL]) },
        }),
    );

    for (const tenant of tenants) {
      const rules = await TenantContext.runAsSystem(
        'alert rule sweep: read pack',
        () =>
          this.packs.section<AlertRuleDefinition[]>(
            tenant.vertical,
            'alertRules',
          ),
      );

      if (!rules?.length) continue;
      summary.tenantsScanned++;

      // Bound to this tenant for the duration, so every read and write below
      // is filtered by the database, not by this code remembering to.
      await TenantContext.run({ tenantId: tenant.id }, async () => {
        for (const rule of rules) {
          await this.applyRule(tenant, rule, now, summary);
        }
      });
    }

    this.logger.log(
      `Alert sweep: ${summary.tenantsScanned} tenants, ${summary.rulesEvaluated} rules, ` +
        `${summary.entitiesScanned} entities → opened ${summary.opened}, ` +
        `notified ${summary.notified}, escalated ${summary.escalated}, ` +
        `resolved ${summary.resolved}`,
    );

    return summary;
  }

  private async applyRule(
    tenant: Tenant,
    rule: AlertRuleDefinition,
    now: Date,
    summary: AlertSweepSummary,
  ): Promise<void> {
    // Validate before scanning. A rule that cannot compile is a pack authoring
    // error and is reported as one — the alternative is an exception thrown
    // from inside a loop over a customer's records at 3am.
    const check = this.evaluator.validate(rule.when);
    if (!check.valid) {
      summary.invalidRules.push({
        tenantId: tenant.id,
        ruleKey: rule.key,
        reason: check.reason,
      });
      this.logger.error(
        `Alert rule '${rule.key}' (${tenant.vertical}) is not evaluable and was ` +
          `skipped: ${check.reason}`,
      );
      return;
    }

    summary.rulesEvaluated++;

    const entities = await this.entityRepo.find({
      where: {
        tenantId: tenant.id,
        type: rule.entityType as UniversalEntity['type'],
        deletedAt: IsNull(),
      },
      take: MAX_ENTITIES_PER_RULE,
      order: { updatedAt: 'DESC' },
    });

    if (entities.length === MAX_ENTITIES_PER_RULE) {
      this.logger.warn(
        `Alert rule '${rule.key}' hit the ${MAX_ENTITIES_PER_RULE}-entity cap for ` +
          `tenant ${tenant.id}; older records were not evaluated this pass.`,
      );
    }

    const firings = await this.firingRepo.find({
      where: { tenantId: tenant.id, ruleKey: rule.key },
    });
    const byEntity = new Map(firings.map((f) => [f.entityId, f]));

    for (const entity of entities) {
      summary.entitiesScanned++;

      const matched = this.evaluator.matches(
        rule.when,
        entity as unknown as Record<string, unknown>,
      );
      const existing = byEntity.get(entity.id);

      if (!matched) {
        // Resolve rather than delete: a condition that clears and returns is a
        // second incident, and the history is the auditable part.
        if (existing && !existing.resolvedAt) {
          existing.resolvedAt = now;
          await this.firingRepo.save(existing);
          summary.resolved++;
        }
        continue;
      }

      await this.handleMatch(tenant, rule, entity, existing, now, summary);
    }
  }

  private async handleMatch(
    tenant: Tenant,
    rule: AlertRuleDefinition,
    entity: UniversalEntity,
    existing: AlertFiring | undefined,
    now: Date,
    summary: AlertSweepSummary,
  ): Promise<void> {
    let firing = existing;

    // A previously-resolved firing that matches again starts a new incident:
    // the clocks reset, so escalation measures from this occurrence and not
    // from one that was fixed months ago.
    if (!firing || firing.resolvedAt) {
      const reopened = firing !== undefined;
      firing = this.firingRepo.create({
        ...(firing ?? {}),
        tenantId: tenant.id,
        ruleKey: rule.key,
        entityId: entity.id,
        entityType: entity.type,
        firstMatchedAt: now,
        lastMatchedAt: now,
        lastNotifiedAt: null,
        notifyCount: reopened ? 0 : 0,
        escalatedAt: null,
        resolvedAt: null,
      });
      summary.opened++;
    } else {
      firing.lastMatchedAt = now;
    }

    const cooldownHours = rule.cooldownHours ?? 24;
    const dueForNotify =
      !firing.lastNotifiedAt ||
      now.getTime() - firing.lastNotifiedAt.getTime() >=
        cooldownHours * 3_600_000;

    if (dueForNotify) {
      const recipients = await this.recipientsFor(
        tenant.id,
        rule.notifyRoles ?? [],
        entity,
      );
      await this.notify(tenant, rule, entity, recipients, false);
      firing.lastNotifiedAt = now;
      firing.notifyCount++;
      summary.notified++;

      if (rule.createTask && !firing.taskId) {
        // An alert with no owner is an inbox item; a task has someone
        // accountable, which is the difference the specs actually asked for.
        const assignee = entity.assignedTo ?? recipients[0] ?? null;
        if (assignee) {
          const task = await this.tasks.createTask(tenant.id, {
            title: `${rule.label} — ${this.describe(entity)}`,
            description:
              `Raised automatically by alert rule '${rule.key}'. ` +
              `Resolves when the condition no longer holds.`,
            type: TaskType.ACTION,
            priority:
              rule.severity === 'critical'
                ? TaskPriority.URGENT
                : TaskPriority.MEDIUM,
            assignedTo: assignee,
            // The sweep has no human actor; attributing the task to a user
            // would misreport who raised it in the audit trail.
            assignedBy: 'system',
            entityId: entity.id,
            entityType: entity.type,
          });
          firing.taskId = task.id;
          summary.tasksCreated++;
        }
      }
    }

    // Escalation is once per incident, and only while the condition still
    // holds. A rule that escalates on every pass is worse than one that never
    // escalates — the second is ignored, the first is actively distrusted.
    const escalateAfter = rule.escalateAfterHours ?? null;
    if (
      escalateAfter !== null &&
      !firing.escalatedAt &&
      now.getTime() - firing.firstMatchedAt.getTime() >=
        escalateAfter * 3_600_000
    ) {
      const escalationRecipients = await this.recipientsFor(
        tenant.id,
        rule.escalateToRoles ?? [],
        entity,
      );
      if (escalationRecipients.length) {
        await this.notify(tenant, rule, entity, escalationRecipients, true);
        firing.escalatedAt = now;
        summary.escalated++;
      }
    }

    await this.firingRepo.save(firing);
  }

  /**
   * Roles → user ids, falling back to the entity's assignee.
   *
   * `notifyRoles: []` means "whoever owns this record", which is the right
   * default for a per-case alert: broadcasting every expiring visa to every
   * admin is how an alert channel becomes noise.
   */
  private async recipientsFor(
    tenantId: string,
    roles: string[],
    entity: UniversalEntity,
  ): Promise<string[]> {
    if (!roles.length) {
      return entity.assignedTo ? [entity.assignedTo] : [];
    }

    const users = await this.userRepo.find({
      where: { tenantId, status: UserStatus.ACTIVE },
      select: ['id', 'roles'],
    });

    const matched = users
      .filter((u) => (u.roles ?? []).some((r) => roles.includes(r)))
      .map((u) => u.id);

    // A rule naming a role nobody holds would otherwise fire into nothing on
    // every pass and look, from the outside, exactly like a rule that never
    // matched.
    if (!matched.length) {
      this.logger.warn(
        `Alert rule targets roles [${roles.join(', ')}] but tenant ${tenantId} ` +
          `has no active user in any of them; falling back to the assignee.`,
      );
      return entity.assignedTo ? [entity.assignedTo] : [];
    }

    return matched;
  }

  private async notify(
    tenant: Tenant,
    rule: AlertRuleDefinition,
    entity: UniversalEntity,
    recipients: string[],
    isEscalation: boolean,
  ): Promise<void> {
    if (!recipients.length) {
      this.logger.warn(
        `Alert '${rule.key}' matched entity ${entity.id} but has no recipient — ` +
          `no assignee and no matching role.`,
      );
      return;
    }

    const priority =
      rule.severity === 'critical' || isEscalation
        ? NotificationPriority.URGENT
        : rule.severity === 'info'
          ? NotificationPriority.LOW
          : NotificationPriority.HIGH;

    const prefix = isEscalation ? 'ESCALATED: ' : '';
    const variables = {
      ...(entity.verticalAttributes ?? {}),
      entityId: entity.id,
      entityType: entity.type,
      entityName: this.describe(entity),
      ruleLabel: rule.label,
      dueDate: entity.dueDate?.toISOString() ?? '',
    };

    for (const recipientId of recipients) {
      try {
        if (rule.templateKey) {
          // Pack-supplied wording. The template is resolved tenant-first and
          // then from the pack, so a firm can override the words without
          // core knowing the vertical's vocabulary.
          await this.notifications.sendFromTemplate(
            tenant.id,
            rule.templateKey,
            recipientId,
            variables,
            tenant.vertical,
          );
        } else {
          await this.notifications.sendNotification({
            tenantId: tenant.id,
            type: NotificationType.IN_APP,
            recipientId,
            category: NotificationCategory.SYSTEM,
            priority,
            subject: `${prefix}${rule.label}`,
            content: `${rule.label} — ${this.describe(entity)}`,
            metadata: {
              alertRuleKey: rule.key,
              entityId: entity.id,
              entityType: entity.type,
              escalation: isEscalation,
            },
          });
        }
      } catch (err) {
        // One undeliverable recipient must not abandon the rest, and must not
        // abort the sweep for every tenant queued behind this one.
        this.logger.error(
          `Alert '${rule.key}' could not notify ${recipientId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  /** Best available human label, without core learning any vertical's nouns. */
  private describe(entity: UniversalEntity): string {
    const attrs = entity.verticalAttributes ?? {};
    const named =
      [entity.firstName, entity.lastName].filter(Boolean).join(' ') ||
      (typeof attrs.name === 'string' ? attrs.name : '') ||
      (typeof attrs.title === 'string' ? attrs.title : '') ||
      (typeof attrs.reference === 'string' ? attrs.reference : '');

    return named || `${entity.type} ${entity.id.slice(0, 8)}`;
  }

  /** Open (unresolved) alerts for a tenant — what an alerts page renders. */
  async listOpen(tenantId: string): Promise<AlertFiring[]> {
    return this.firingRepo.find({
      where: { tenantId, resolvedAt: IsNull() },
      order: { firstMatchedAt: 'DESC' },
      take: 200,
    });
  }

  /** Recently resolved, so a UI can show that an alert closed rather than vanished. */
  async listResolved(tenantId: string, limit = 50): Promise<AlertFiring[]> {
    return this.firingRepo.find({
      where: { tenantId, resolvedAt: Not(IsNull()) },
      order: { resolvedAt: 'DESC' },
      take: limit,
    });
  }
}
