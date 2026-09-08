import { AlertRuleService, type AlertRuleDefinition } from './alert-rule.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { AlertFiring } from './entities/alert-firing.entity';
import { EntityType } from '../crm/entities/universal-entity.entity';
import { TenantStatus } from '../iam/entities/tenant.entity';

/**
 * The behaviour under test is the *memory*, not the predicate — the predicate
 * is `RuleEvaluatorService`, tested separately.
 *
 * A sweep with no memory notifies on every pass, because a condition worth
 * alerting on ("visa expires within 30 days") is true on every one of those
 * days. That is not a cosmetic flaw: people filter a sender that mails them
 * thirty times, and the alert that mattered goes with the rest. So what is
 * asserted here is that the second pass stays quiet, escalation happens once,
 * a cleared condition resolves, and a returning one is a new incident.
 */
describe('AlertRuleService', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  const rule: AlertRuleDefinition = {
    key: 'visa_expiring',
    label: 'Visa expiring',
    entityType: 'case',
    when: { '<': [{ var: 'visaExpiry_daysUntil' }, 30] },
    severity: 'warning',
    cooldownHours: 24,
    escalateAfterHours: 48,
    escalateToRoles: ['firm_admin'],
    notifyRoles: [],
  };

  /** One case whose visa expires in 10 days, owned by a user. */
  const makeEntity = (overrides: Record<string, unknown> = {}) => ({
    id: '22222222-2222-2222-2222-222222222222',
    tenantId: TENANT,
    type: EntityType.CASE,
    firstName: 'Ada',
    lastName: 'Lovelace',
    assignedTo: '33333333-3333-3333-3333-333333333333',
    dueDate: null,
    deletedAt: null,
    verticalAttributes: { visaExpiry: '2026-08-20T00:00:00Z' },
    ...overrides,
  });

  function build(opts: {
    entities?: Record<string, unknown>[];
    rules?: AlertRuleDefinition[];
  } = {}) {
    const firings: AlertFiring[] = [];
    const notified: Array<Record<string, unknown>> = [];
    const tasksCreated: Array<Record<string, unknown>> = [];

    const firingRepo = {
      find: jest.fn(() => Promise.resolve([...firings])),
      create: jest.fn((x: Partial<AlertFiring>) => ({ ...x }) as AlertFiring),
      save: jest.fn((row: AlertFiring) => {
        const existing = firings.findIndex(
          (f) => f.ruleKey === row.ruleKey && f.entityId === row.entityId,
        );
        // Mirrors the unique index on (tenantId, ruleKey, entityId): the sweep
        // upserts on it, so two overlapping passes cannot produce two firing
        // records for one condition and notify twice.
        if (existing >= 0) firings[existing] = row;
        else firings.push(row);
        return Promise.resolve(row);
      }),
    };

    const entityRepo = {
      find: jest.fn(() =>
        Promise.resolve(opts.entities ?? [makeEntity()]),
      ),
    };

    const tenantRepo = {
      find: jest.fn(() =>
        Promise.resolve([
          {
            id: TENANT,
            vertical: 'immigration',
            status: TenantStatus.ACTIVE,
          },
        ]),
      ),
    };

    const userRepo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: '44444444-4444-4444-4444-444444444444', roles: ['firm_admin'] },
        ]),
      ),
    };

    const packs = {
      section: jest.fn(() => Promise.resolve(opts.rules ?? [rule])),
    };

    const notifications = {
      sendNotification: jest.fn((o: Record<string, unknown>) => {
        notified.push(o);
        return Promise.resolve({ id: 'n1' });
      }),
      sendFromTemplate: jest.fn((...args: unknown[]) => {
        notified.push({ template: args[1], recipientId: args[2] });
        return Promise.resolve({ id: 'n1' });
      }),
    };

    const tasks = {
      createTask: jest.fn((_tenantId: string, dto: Record<string, unknown>) => {
        tasksCreated.push(dto);
        return Promise.resolve({ id: '55555555-5555-5555-5555-555555555555' });
      }),
    };

    const service = new AlertRuleService(
      firingRepo as never,
      entityRepo as never,
      tenantRepo as never,
      userRepo as never,
      new RuleEvaluatorService(),
      packs as never,
      notifications as never,
      tasks as never,
    );

    return { service, firings, notified, tasksCreated, notifications, tasks };
  }

  const day = (n: number) => new Date(`2026-08-${String(n).padStart(2, '0')}T09:00:00Z`);

  it('opens a firing and notifies on the first pass', async () => {
    const { service, notified, firings } = build();

    const summary = await service.sweep(day(10));

    expect(summary.opened).toBe(1);
    expect(summary.notified).toBe(1);
    expect(notified).toHaveLength(1);
    expect(firings[0].notifyCount).toBe(1);
    // No role named ⇒ the record's owner, not a broadcast. Mailing every
    // expiring visa to every admin is how an alert channel becomes noise.
    expect(notified[0].recipientId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('stays silent on a second pass inside the cooldown', async () => {
    const { service, notified } = build();

    await service.sweep(day(10));
    const second = await service.sweep(new Date('2026-08-10T21:00:00Z'));

    expect(second.opened).toBe(0);
    expect(second.notified).toBe(0);
    expect(notified).toHaveLength(1);
  });

  it('notifies again once the cooldown has elapsed', async () => {
    const { service, notified } = build();

    await service.sweep(day(10));
    const later = await service.sweep(day(12));

    expect(later.notified).toBe(1);
    // Counted excluding the escalation, which day(12) also triggers — it is
    // 48h after the first match and the rule escalates at 48h.
    const routine = notified.filter(
      (n) => !(n.metadata as Record<string, unknown> | undefined)?.escalation,
    );
    expect(routine).toHaveLength(2);
  });

  it('escalates once, not on every subsequent pass', async () => {
    const { service, notified } = build();

    await service.sweep(day(10));
    const atEscalation = await service.sweep(day(13)); // 72h later
    const after = await service.sweep(day(15));

    expect(atEscalation.escalated).toBe(1);
    expect(after.escalated).toBe(0);

    // The escalation went to the role, not to the assignee.
    const escalations = notified.filter(
      (n) => (n.metadata as Record<string, unknown> | undefined)?.escalation,
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0].recipientId).toBe(
      '44444444-4444-4444-4444-444444444444',
    );
  });

  it('resolves the firing when the condition stops being true', async () => {
    const entity = makeEntity();
    const { service, firings } = build({ entities: [entity] });

    await service.sweep(day(10));

    // The visa was extended.
    entity.verticalAttributes = { visaExpiry: '2027-08-20T00:00:00Z' };
    const summary = await service.sweep(day(11));

    expect(summary.resolved).toBe(1);
    expect(firings[0].resolvedAt).toEqual(day(11));
  });

  it('treats a condition that returns as a new incident', async () => {
    const entity = makeEntity();
    const { service, firings, notified } = build({ entities: [entity] });

    await service.sweep(day(10));
    entity.verticalAttributes = { visaExpiry: '2027-08-20T00:00:00Z' };
    await service.sweep(day(11));
    entity.verticalAttributes = { visaExpiry: '2026-08-20T00:00:00Z' };
    const reopened = await service.sweep(day(12));

    expect(reopened.opened).toBe(1);
    // Notified again despite the cooldown, because the clocks reset — a
    // problem that was fixed and came back is news.
    expect(notified).toHaveLength(2);
    expect(firings[0].resolvedAt).toBeNull();
    expect(firings[0].firstMatchedAt).toEqual(day(12));
    // Escalation measures from this occurrence, not from the one that was
    // fixed: without the reset, a returning condition would escalate instantly.
    expect(firings[0].escalatedAt).toBeNull();
  });

  it('skips a rule it cannot compile, and says which and why', async () => {
    const { service, notified } = build({
      rules: [{ ...rule, when: { exec: ['whoami'] } }],
    });

    const summary = await service.sweep(day(10));

    expect(summary.invalidRules).toEqual([
      {
        tenantId: TENANT,
        ruleKey: 'visa_expiring',
        reason: expect.stringContaining('exec'),
      },
    ]);
    expect(summary.rulesEvaluated).toBe(0);
    expect(notified).toHaveLength(0);
  });

  it('opens one task per firing, not one per notification', async () => {
    const { service, tasksCreated } = build({
      rules: [{ ...rule, createTask: true }],
    });

    await service.sweep(day(10));
    await service.sweep(day(12)); // second notification, same incident

    expect(tasksCreated).toHaveLength(1);
    expect(tasksCreated[0].assignedBy).toBe('system');
  });

  it('uses the pack template when the rule names one', async () => {
    const { service, notifications } = build({
      rules: [{ ...rule, templateKey: 'visa_expiry_warning' }],
    });

    await service.sweep(day(10));

    expect(notifications.sendFromTemplate).toHaveBeenCalledWith(
      TENANT,
      'visa_expiry_warning',
      '33333333-3333-3333-3333-333333333333',
      expect.objectContaining({ entityName: 'Ada Lovelace' }),
      'immigration',
    );
  });
});
