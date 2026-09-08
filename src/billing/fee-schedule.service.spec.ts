import {
  FeeScheduleService,
  type FeeDefinition,
  type PaymentPlanDefinition,
} from './fee-schedule.service';
import { Payment, PaymentStatus } from './entities/payment.entity';
import type { TenantFeeOverride } from './entities/tenant-fee-override.entity';
import { BadRequestException } from '@nestjs/common';

/**
 * The arithmetic is the point.
 *
 * Money split N ways rarely divides evenly, and both easy answers are wrong:
 * rounding each portion means the portions no longer sum to the fee, and
 * truncating means the firm quietly under-bills. A regulated ledger that is
 * short by three cents per case is a reconciliation problem someone finds
 * months later.
 */
describe('FeeScheduleService', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const ENTITY = '22222222-2222-2222-2222-222222222222';
  const CLIENT = '33333333-3333-3333-3333-333333333333';

  const fees: FeeDefinition[] = [
    {
      key: 'gov_482',
      label: 'Subclass 482 application charge',
      kind: 'government',
      amountMinor: 130000,
      currency: 'AUD',
      basis: 'per_case',
      reference: 'Migration Regulations 1994, Sch 1',
    },
    {
      key: 'firm_professional',
      label: 'Professional fees',
      kind: 'firm',
      amountMinor: 100000,
      currency: 'AUD',
      basis: 'per_case',
    },
    {
      key: 'gov_dependent',
      label: 'Dependent charge',
      kind: 'government',
      amountMinor: 65000,
      currency: 'AUD',
      basis: 'per_dependent',
    },
    {
      key: 'disb_health_examination',
      label: 'Health examination',
      kind: 'disbursement',
      amountMinor: 40000,
      currency: 'AUD',
      basis: 'per_applicant',
    },
  ];

  const plans: PaymentPlanDefinition[] = [
    { key: 'upfront', label: 'Pay upfront', type: 'upfront' },
    {
      key: 'three_monthly',
      label: 'Three instalments',
      type: 'installments',
      installmentCount: 3,
      intervalDays: 30,
    },
    {
      key: 'staged',
      label: 'Staged',
      type: 'stage_gated',
      stages: [
        { atStep: 'engagement', portionBps: 3333, label: 'On engagement' },
        { atStep: 'lodgement', portionBps: 3333, label: 'On lodgement' },
        { atStep: 'decision', portionBps: 3334, label: 'On decision' },
      ],
      blockProgressOnArrears: true,
    },
    {
      key: 'broken',
      label: 'Does not sum',
      type: 'stage_gated',
      stages: [
        { atStep: 'a', portionBps: 5000 },
        { atStep: 'b', portionBps: 4000 },
      ],
    },
  ];

  /**
   * A minimal in-memory `tenant_fee_overrides` table, scoped by `tenantId`
   * the same way the real RLS-carrying table is — `find` never returns a row
   * belonging to a different tenant, so a test that seeds tenant A's override
   * and reads as tenant B is a genuine isolation check, not a stub that
   * happens to answer right.
   */
  function overrideRepoStub(seed: Partial<TenantFeeOverride>[] = []) {
    const store: Partial<TenantFeeOverride>[] = seed.map((r) => ({ ...r }));
    let nextId = store.length + 1;
    return {
      store,
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          store.filter(
            (r) =>
              r.tenantId === where.tenantId &&
              (where.active === undefined || r.active === where.active),
          ),
        ),
      ),
      create: jest.fn(
        (x: Partial<TenantFeeOverride>) =>
          ({ active: true, ...x }) as TenantFeeOverride,
      ),
      save: jest.fn((row: Partial<TenantFeeOverride>) => {
        const idx = store.findIndex((r) => r.id && r.id === row.id);
        const stored = { id: row.id ?? `override-${nextId++}`, ...row };
        if (idx >= 0) store[idx] = stored;
        else store.push(stored);
        return Promise.resolve(stored as TenantFeeOverride);
      }),
      remove: jest.fn((row: Partial<TenantFeeOverride>) => {
        const idx = store.findIndex((r) => r.id === row.id);
        if (idx >= 0) store.splice(idx, 1);
        return Promise.resolve(row as TenantFeeOverride);
      }),
    };
  }

  const auditStub = { logEvent: jest.fn(() => Promise.resolve({})) };

  function build(
    existing: Payment[] = [],
    overrides: ReturnType<typeof overrideRepoStub> = overrideRepoStub(),
  ) {
    const saved: Payment[] = [];
    const repo = {
      find: jest.fn(() => Promise.resolve(existing)),
      create: jest.fn((x: Partial<Payment>) => ({ ...x }) as Payment),
      save: jest.fn((rows: Payment[]) => {
        saved.push(...rows);
        return Promise.resolve(rows);
      }),
    };
    const packs = {
      section: jest.fn((_vertical: string, key: string) =>
        Promise.resolve(key === 'fees' ? fees : plans),
      ),
      // `catalogue` calls `.list`, which the real VerticalPackService derives
      // from `.section` (empty array rather than null/undefined).
      list: jest.fn((_vertical: string, key: string) =>
        Promise.resolve(key === 'fees' ? fees : plans),
      ),
    };
    const service = new FeeScheduleService(
      repo as never,
      overrides as never,
      packs as never,
      paymentsStub as never,
      auditStub as never,
    );
    return { service, repo, saved, overrides };
  }

  /**
   * `expand` now resolves `clientId` through `PaymentsService` so both write
   * paths store `users.id` (see the note on `Payment.clientId`). These tests
   * are about fee arithmetic, not id resolution, so the stub is the identity
   * function — every existing expectation on `clientId` holds unchanged.
   */
  const paymentsStub = {
    resolveClientUserId: jest.fn(async (_tenantId: string, clientId: string) => clientId),
  };

  const base = {
    tenantId: TENANT,
    vertical: 'immigration',
    entityId: ENTITY,
    clientId: CLIENT,
  };

  it('expands a fee into one payable row, tagged with its provenance', async () => {
    const { service } = build();

    const rows = await service.expand({ ...base, feeKeys: ['gov_482'] });

    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe('130000');
    // The distinction the old undifferentiated amountMinor could not make: a
    // government charge passed through at cost is not the firm's revenue.
    expect(rows[0].feeKind).toBe('government');
    expect(rows[0].feeKey).toBe('gov_482');
    expect(rows[0].metadata).toMatchObject({
      feeReference: 'Migration Regulations 1994, Sch 1',
    });
  });

  it('multiplies a per-dependent fee by the dependents', async () => {
    const { service } = build();

    const rows = await service.expand({
      ...base,
      feeKeys: ['gov_dependent'],
      dependents: 3,
    });

    expect(rows[0].amountMinor).toBe('195000');
  });

  it('charges nothing for a per-dependent fee with no dependents', async () => {
    const { service } = build();

    const rows = await service.expand({
      ...base,
      feeKeys: ['gov_dependent'],
      dependents: 0,
    });

    expect(rows).toHaveLength(0);
  });

  it('splits instalments so they sum to the fee exactly', async () => {
    const { service } = build();

    // 130000 / 3 does not divide evenly.
    const rows = await service.expand({
      ...base,
      feeKeys: ['gov_482'],
      planKey: 'three_monthly',
    });

    expect(rows).toHaveLength(3);
    const total = rows.reduce((sum, r) => sum + Number(r.amountMinor), 0);
    expect(total).toBe(130000);
    // The remainder lands on the first instalment, so every later one is a
    // round number the client can reconcile.
    expect(rows.map((r) => Number(r.amountMinor))).toEqual([
      43334, 43333, 43333,
    ]);
  });

  it('dates instalments from the start date at the plan interval', async () => {
    const { service } = build();

    const rows = await service.expand({
      ...base,
      feeKeys: ['gov_482'],
      planKey: 'three_monthly',
      startDate: new Date('2026-08-10T00:00:00Z'),
    });

    expect(rows[0].dueDate).toEqual(new Date('2026-08-10T00:00:00Z'));
    expect(rows[1].dueDate).toEqual(new Date('2026-09-09T00:00:00Z'));
  });

  it('splits stage-gated portions to the last cent, and tags the step', async () => {
    const { service } = build();

    const rows = await service.expand({
      ...base,
      feeKeys: ['firm_professional'],
      planKey: 'staged',
    });

    const total = rows.reduce((sum, r) => sum + Number(r.amountMinor), 0);
    expect(total).toBe(100000);
    expect(rows.map((r) => r.atStep)).toEqual([
      'engagement',
      'lodgement',
      'decision',
    ]);
  });

  it('refuses a plan whose stages do not sum to 100%', async () => {
    const { service } = build();

    // Silently billing 90% of the fee is the alternative, discovered from a
    // ledger months later.
    await expect(
      service.expand({
        ...base,
        feeKeys: ['firm_professional'],
        planKey: 'broken',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to expand fees in mixed currencies under one plan', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue([]);
    fees.push({
      key: 'gbp_fee',
      label: 'UK fee',
      amountMinor: 10000,
      currency: 'GBP',
    });

    await expect(
      service.expand({
        ...base,
        feeKeys: ['gov_482', 'gbp_fee'],
        planKey: 'staged',
      }),
    ).rejects.toThrow(/mixed currencies/);

    fees.pop();
  });

  it('does not charge twice when re-run for the same case', async () => {
    // A retry after a partial failure is the normal way this gets called a
    // second time.
    const alreadyThere = [
      { id: 'p1', feeKey: 'gov_482', amountMinor: '130000' } as Payment,
    ];
    const { service, saved } = build(alreadyThere);

    const rows = await service.expand({ ...base, feeKeys: ['gov_482'] });

    expect(rows).toBe(alreadyThere);
    expect(saved).toHaveLength(0);
  });

  it('names the pack when a fee is not defined', async () => {
    const { service } = build();

    await expect(
      service.expand({ ...base, feeKeys: ['no_such_fee'] }),
    ).rejects.toThrow(/immigration pack/);
  });

  describe('arrearsBlocking', () => {
    it('is silent unless a plan opts into the gate', async () => {
      const repo = {
        find: jest.fn(() =>
          Promise.resolve([
            {
              id: 'p1',
              planKey: 'three_monthly',
              status: PaymentStatus.PENDING,
            } as Payment,
          ]),
        ),
        create: jest.fn(),
        save: jest.fn(),
      };
      const packs = {
        section: jest.fn(() => Promise.resolve(plans)),
      };
      const service = new FeeScheduleService(
        repo as never,
        overrideRepoStub() as never,
        packs as never,
        paymentsStub as never,
        auditStub as never,
      );

      // `three_monthly` does not set blockProgressOnArrears. A firm that never
      // asked for frozen cases must not have its workflows stopped because
      // someone authored a fee schedule.
      const blocking = await service.arrearsBlocking(
        TENANT,
        'immigration',
        ENTITY,
        'lodgement',
      );
      expect(blocking).toHaveLength(0);
    });

    it('blocks on an unpaid portion belonging to a gating plan', async () => {
      const repo = {
        find: jest.fn(() =>
          Promise.resolve([
            {
              id: 'p1',
              planKey: 'staged',
              status: PaymentStatus.PENDING,
            } as Payment,
          ]),
        ),
        create: jest.fn(),
        save: jest.fn(),
      };
      const packs = { section: jest.fn(() => Promise.resolve(plans)) };
      const service = new FeeScheduleService(
        repo as never,
        overrideRepoStub() as never,
        packs as never,
        paymentsStub as never,
        auditStub as never,
      );

      const blocking = await service.arrearsBlocking(
        TENANT,
        'immigration',
        ENTITY,
        'lodgement',
      );
      expect(blocking).toHaveLength(1);
    });
  });

  /**
   * ADR 0009 §2.4 — a firm's own `kind: 'firm'` fee amount becomes a
   * tenant-scoped override. Everything else the pack declares — government
   * charges, disbursements, payment-plan structure — stays pack-owned.
   */
  describe('tenant fee overrides (ADR 0009 §2.4)', () => {
    const OTHER_TENANT = '44444444-4444-4444-4444-444444444444';
    const OPERATOR = '55555555-5555-5555-5555-555555555555';

    it("replaces the pack amount for a 'firm' fee, for that tenant only", async () => {
      const overrides = overrideRepoStub([
        {
          id: 'ov1',
          tenantId: TENANT,
          feeKey: 'firm_professional',
          amountMinor: '280000',
          currency: 'AUD',
          active: true,
        } as TenantFeeOverride,
      ]);
      const { service } = build([], overrides);

      const rows = await service.expand({
        ...base,
        feeKeys: ['firm_professional'],
      });

      // Pack default is 100000 (see the `fees` fixture) — the override wins.
      expect(rows[0].amountMinor).toBe('280000');
      expect(rows[0].currency).toBe('AUD');
      // Nothing structural moved: the row is still tagged as a firm fee.
      expect(rows[0].feeKind).toBe('firm');

      const { fees: catalogueFees } = await service.catalogue(
        'immigration',
        TENANT,
      );
      const professional = catalogueFees.find(
        (f) => f.key === 'firm_professional',
      );
      expect(professional?.amountMinor).toBe(280000);
    });

    it('leaves a tenant with no override on the pack amount', async () => {
      // Empty override store — the base case every ImmiStack tenant on the
      // unpinned pack is in today.
      const { service } = build();

      const rows = await service.expand({
        ...base,
        feeKeys: ['firm_professional'],
      });

      expect(rows[0].amountMinor).toBe('100000');

      const { fees: catalogueFees } = await service.catalogue(
        'immigration',
        TENANT,
      );
      const professional = catalogueFees.find(
        (f) => f.key === 'firm_professional',
      );
      expect(professional?.amountMinor).toBe(100000);
    });

    it('refuses to override a government fee', async () => {
      const overrides = overrideRepoStub();
      const { service } = build([], overrides);

      await expect(
        service.setOverrides(
          TENANT,
          'immigration',
          [{ feeKey: 'gov_482', amountMinor: 1, currency: 'AUD' }],
          OPERATOR,
        ),
      ).rejects.toThrow(BadRequestException);
      // Rejected before any row was written.
      expect(overrides.store).toHaveLength(0);
    });

    it('refuses to override a disbursement fee', async () => {
      const overrides = overrideRepoStub();
      const { service } = build([], overrides);

      await expect(
        service.setOverrides(
          TENANT,
          'immigration',
          [
            {
              feeKey: 'disb_health_examination',
              amountMinor: 1,
              currency: 'AUD',
            },
          ],
          OPERATOR,
        ),
      ).rejects.toThrow(/disbursement/);
      expect(overrides.store).toHaveLength(0);
    });

    it("refuses a feeKey the pack doesn't define", async () => {
      const overrides = overrideRepoStub();
      const { service } = build([], overrides);

      await expect(
        service.setOverrides(
          TENANT,
          'immigration',
          [{ feeKey: 'no_such_fee', amountMinor: 1, currency: 'AUD' }],
          OPERATOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("is tenant-isolated: tenant A's override never reaches tenant B", async () => {
      const overrides = overrideRepoStub([
        {
          id: 'ov1',
          tenantId: TENANT,
          feeKey: 'firm_professional',
          amountMinor: '280000',
          currency: 'AUD',
          active: true,
        } as TenantFeeOverride,
      ]);
      const { service } = build([], overrides);

      const rowsForOwner = await service.expand({
        ...base,
        feeKeys: ['firm_professional'],
      });
      expect(rowsForOwner[0].amountMinor).toBe('280000');

      const rowsForOther = await service.expand({
        ...base,
        tenantId: OTHER_TENANT,
        feeKeys: ['firm_professional'],
      });
      // Same shared override store, different tenant: the pack default, not
      // tenant A's price.
      expect(rowsForOther[0].amountMinor).toBe('100000');
    });

    it('setOverrides writes a complete desired state — omitting a key reverts it to the pack default', async () => {
      const overrides = overrideRepoStub([
        {
          id: 'ov1',
          tenantId: TENANT,
          feeKey: 'firm_professional',
          amountMinor: '280000',
          currency: 'AUD',
          active: true,
        } as TenantFeeOverride,
      ]);
      const { service } = build([], overrides);

      // A PUT naming no overrides at all clears the existing one — the same
      // "complete desired state" contract as OperatorUpdateEntitlementsDto.
      await service.setOverrides(TENANT, 'immigration', [], OPERATOR);

      expect(overrides.store).toHaveLength(0);

      const rows = await service.expand({
        ...base,
        feeKeys: ['firm_professional'],
      });
      expect(rows[0].amountMinor).toBe('100000');
    });

    it('audits every override write with the previous amount', async () => {
      const overrides = overrideRepoStub();
      const { service } = build([], overrides);
      auditStub.logEvent.mockClear();

      await service.setOverrides(
        TENANT,
        'immigration',
        [{ feeKey: 'firm_professional', amountMinor: 280000, currency: 'AUD' }],
        OPERATOR,
      );

      expect(auditStub.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          userId: OPERATOR,
          context: expect.objectContaining({
            feeKey: 'firm_professional',
            amountMinor: 280000,
            currency: 'AUD',
            previousAmountMinor: null,
          }),
        }),
      );
    });
  });
});
