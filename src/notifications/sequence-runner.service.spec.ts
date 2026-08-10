import {
  SequenceRunnerService,
  type SequenceDefinition,
} from './sequence-runner.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { EntityType } from '../crm/entities/universal-entity.entity';
import { TenantStatus } from '../iam/entities/tenant.entity';

/**
 * What is worth testing here is when the sequence *stops*.
 *
 * The steps going out on schedule is the easy half. The half that damages a
 * client relationship is a chaser that keeps asking for a document that
 * arrived last week, so the stop conditions — the explicit one, the trigger
 * clearing, the message cap, and the finality of a stop — get the coverage.
 */
describe('SequenceRunnerService', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  const sequence: SequenceDefinition = {
    key: 'chase_docs',
    label: 'Chase outstanding documents',
    trigger: {
      entityType: 'case',
      when: { '!': { var: 'documentsReceivedAt' } },
    },
    steps: [
      { templateKey: 'document_request', afterHours: 0 },
      { templateKey: 'document_request', afterHours: 48 },
      { templateKey: 'document_request', afterHours: 120 },
    ],
    stopOnReply: true,
    maxMessages: 3,
  };

  const makeEntity = (overrides: Record<string, unknown> = {}) => ({
    id: '22222222-2222-2222-2222-222222222222',
    tenantId: TENANT,
    type: EntityType.CASE,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    dueDate: null,
    deletedAt: null,
    status: 'open',
    verticalAttributes: {} as Record<string, unknown>,
    ...overrides,
  });

  function build(
    opts: {
      entities?: Record<string, unknown>[];
      sequences?: SequenceDefinition[];
    } = {},
  ) {
    const enrolments: SequenceEnrolment[] = [];
    const sent: Array<Record<string, unknown>> = [];

    const enrolmentRepo = {
      find: jest.fn(() => Promise.resolve([...enrolments])),
      create: jest.fn(
        (x: Partial<SequenceEnrolment>) => ({ ...x }) as SequenceEnrolment,
      ),
      save: jest.fn((row: SequenceEnrolment) => {
        const at = enrolments.findIndex(
          (e) => e.sequenceKey === row.sequenceKey && e.entityId === row.entityId,
        );
        if (at >= 0) enrolments[at] = row;
        else enrolments.push(row);
        return Promise.resolve(row);
      }),
    };

    const entityRepo = {
      find: jest.fn(() => Promise.resolve(opts.entities ?? [makeEntity()])),
    };

    const tenantRepo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: TENANT, vertical: 'immigration', status: TenantStatus.ACTIVE },
        ]),
      ),
    };

    const packs = {
      section: jest.fn(() =>
        Promise.resolve({ sequences: opts.sequences ?? [sequence] }),
      ),
    };

    const notifications = {
      sendFromTemplate: jest.fn((...args: unknown[]) => {
        sent.push({
          templateKey: args[1],
          recipientId: args[2],
          variables: args[3],
          options: args[5],
        });
        return Promise.resolve({ id: 'n1' });
      }),
    };

    const service = new SequenceRunnerService(
      enrolmentRepo as never,
      entityRepo as never,
      tenantRepo as never,
      new RuleEvaluatorService(),
      packs as never,
      notifications as never,
    );

    return { service, enrolments, sent };
  }

  const at = (day: number, hour = 9) =>
    new Date(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`);

  it('enrols a matching record and sends the first step immediately', async () => {
    const { service, sent, enrolments } = build();

    const summary = await service.run(at(10));

    expect(summary.enrolled).toBe(1);
    expect(summary.sent).toBe(1);
    expect(enrolments[0].stepsSent).toBe(1);
    expect(sent[0].templateKey).toBe('document_request');
  });

  it('addresses a client who is not a platform user', async () => {
    const { service, sent } = build();

    await service.run(at(10));

    // The recipient is a CRM record with no login, so the address has to
    // travel with the message — otherwise the dispatcher looks it up in
    // `users`, finds nothing, and records "recipient has no email address".
    expect((sent[0].options as Record<string, unknown>).recipientEmail).toBe(
      'ada@example.com',
    );
  });

  it('holds the next step until its delay has elapsed', async () => {
    const { service, sent } = build();

    await service.run(at(10));
    await service.run(at(11)); // 24h — step 2 wants 48h

    expect(sent).toHaveLength(1);
  });

  it('measures delays from enrolment, so a missed sweep catches up', async () => {
    const { service, sent } = build();

    await service.run(at(10));
    // Nothing ran for six days. Steps 2 and 3 are both due; both go out on
    // this pass rather than the schedule sliding six days to the right.
    await service.run(at(16));

    expect(sent).toHaveLength(3);
  });

  it('stops when the trigger clears, even with no stopWhen authored', async () => {
    const entity = makeEntity();
    const { service, enrolments, sent } = build({ entities: [entity] });

    await service.run(at(10));
    entity.verticalAttributes = { documentsReceivedAt: '2026-08-11T09:00:00Z' };
    const summary = await service.run(at(12));

    expect(summary.stopped).toBe(1);
    expect(enrolments[0].stopReason).toBe('trigger_cleared');
    // The document arrived; step 2 must not go out.
    expect(sent).toHaveLength(1);
  });

  it('honours an explicit stopWhen', async () => {
    const entity = makeEntity();
    const { service, enrolments } = build({
      entities: [entity],
      sequences: [
        { ...sequence, stopWhen: { '==': [{ var: 'status' }, 'closed'] } },
      ],
    });

    await service.run(at(10));
    entity.status = 'closed';
    await service.run(at(12));

    expect(enrolments[0].stopReason).toBe('stop_condition');
  });

  it('never sends more than maxMessages, whatever the steps say', async () => {
    const { service, sent, enrolments } = build({
      sequences: [{ ...sequence, maxMessages: 2 }],
    });

    await service.run(at(10));
    await service.run(at(20));

    expect(sent).toHaveLength(2);
    expect(enrolments[0].stopReason).toBe('max_messages');
  });

  it('treats a stop as final and does not re-enrol', async () => {
    const entity = makeEntity();
    const { service, sent } = build({ entities: [entity] });

    await service.run(at(10));
    entity.verticalAttributes = { documentsReceivedAt: '2026-08-11T09:00:00Z' };
    await service.run(at(12)); // stops: trigger cleared

    // The document was rejected and is outstanding again. Re-enrolling here
    // would restart a sequence someone was deliberately taken out of.
    entity.verticalAttributes = {};
    await service.run(at(14));

    expect(sent).toHaveLength(1);
  });

  it('stops when the recipient has replied since enrolling', async () => {
    const entity = makeEntity();
    const { service, enrolments } = build({ entities: [entity] });

    await service.run(at(10));
    entity.verticalAttributes = { repliedAt: '2026-08-11T10:00:00Z' };
    await service.run(at(12));

    expect(enrolments[0].stopReason).toBe('replied');
  });

  it('skips a step whose own condition fails rather than stalling on it', async () => {
    const { service, sent } = build({
      sequences: [
        {
          ...sequence,
          steps: [
            { templateKey: 'document_request', afterHours: 0 },
            {
              templateKey: 'payment_due',
              afterHours: 24,
              when: { var: 'hasUnpaidInvoice' },
            },
            { templateKey: 'document_request', afterHours: 48 },
          ],
        },
      ],
    });

    await service.run(at(10));
    await service.run(at(13));

    // Step 2 never applied to this record; step 3 still goes out. Deferring
    // instead of skipping would stall the sequence forever on an unmet
    // condition.
    expect(sent.map((s) => s.templateKey)).toEqual([
      'document_request',
      'document_request',
    ]);
  });

  it('refuses a sequence whose stop condition cannot compile', async () => {
    const { service, sent } = build({
      sequences: [{ ...sequence, stopWhen: { exec: ['rm'] } }],
    });

    const summary = await service.run(at(10));

    // Refused before enrolling anybody. A sequence that enrols correctly and
    // then cannot evaluate its stop condition would never stop.
    expect(summary.invalidSequences).toEqual([
      {
        tenantId: TENANT,
        sequenceKey: 'chase_docs',
        reason: expect.stringContaining('stopWhen'),
      },
    ]);
    expect(summary.enrolled).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
