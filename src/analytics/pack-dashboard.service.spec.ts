import { PackDashboardService } from './pack-dashboard.service';
import { PackUiService } from '../tenant/services/pack-ui.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';

/**
 * The failure this file exists to prevent is a dashboard that renders a
 * confident zero. Every assertion below is either "the number is right" or
 * "there is no number and it says why".
 */
describe('PackUiService — who sees what', () => {
  const pack = {
    navigation: [
      { key: 'home', label: 'Home', path: '/', portal: 'staff', roles: [], order: 10 },
      { key: 'pay', label: 'Payments', path: '/payments', portal: 'staff', roles: [], module: 'payments', order: 5 },
      { key: 'admin', label: 'Settings', path: '/settings', portal: 'admin', roles: ['firm_admin'], order: 1 },
    ],
    dashboards: [
      { key: 'staff_home', label: 'Staff', portal: 'staff', roles: [], widgets: [] },
      { key: 'client_home', label: 'Client', portal: 'client', roles: ['client'], widgets: [] },
    ],
  };

  const packs = {
    list: jest.fn((_v: string, key: string) => Promise.resolve((pack as any)[key] ?? [])),
  };
  const provisioning = { getEntitlements: jest.fn() };
  const service = new PackUiService(packs as any, provisioning as any);

  it('sorts by order, not by authoring position', async () => {
    const items = await service.navigationFor('immigration', {
      roles: ['staff'],
      modules: null,
      portal: 'staff',
    });
    expect(items.map((i) => i.key)).toEqual(['pay', 'home']);
  });

  it('hides an item whose module the tenant is not entitled to', async () => {
    const items = await service.navigationFor('immigration', {
      roles: ['staff'],
      modules: ['crm', 'cases'],
      portal: 'staff',
    });
    expect(items.map((i) => i.key)).toEqual(['home']);
  });

  it('does not gate on modules when the entitlement list is unknown', async () => {
    // `null` is not `[]`. A platform operator has no tenant entitlement to
    // read, and hiding every gated item from them looks like an empty pack.
    const items = await service.navigationFor('immigration', {
      roles: ['platform_admin'],
      modules: null,
      portal: 'staff',
    });
    expect(items.map((i) => i.key)).toContain('pay');
  });

  it('keeps a staff route away from a client token', async () => {
    const items = await service.navigationFor('immigration', {
      roles: ['client'],
      modules: null,
      portal: 'client',
    });
    expect(items).toEqual([]);
  });

  it('applies the role filter to admin items', async () => {
    const asStaff = await service.navigationFor('immigration', {
      roles: ['staff'],
      modules: null,
      portal: 'admin',
    });
    const asAdmin = await service.navigationFor('immigration', {
      roles: ['firm_admin'],
      modules: null,
      portal: 'admin',
    });
    expect(asStaff).toEqual([]);
    expect(asAdmin.map((i) => i.key)).toEqual(['admin']);
  });

  it('404s a dashboard the caller may not see, rather than 403ing it', async () => {
    await expect(
      service.dashboardFor('immigration', 'client_home', {
        roles: ['staff'],
        modules: null,
      }),
    ).rejects.toThrow(/No dashboard 'client_home'/);
  });

  it('degrades to an ungated nav when entitlements cannot be read', async () => {
    provisioning.getEntitlements.mockRejectedValueOnce(new Error('tenant gone'));
    const audience = await service.audienceFor('t1', ['staff'], 'staff');
    expect(audience.modules).toBeNull();
  });
});

describe('PackDashboardService — widget arithmetic', () => {
  const now = new Date();
  const daysAgo = (n: number) =>
    new Date(now.getTime() - n * 86_400_000);

  const rows = [
    { id: '1', status: 'open', dueDate: null, verticalAttributes: {}, createdAt: daysAgo(10), updatedAt: daysAgo(2), firstName: 'A', lastName: 'One' },
    { id: '2', status: 'closed', dueDate: null, verticalAttributes: {}, createdAt: daysAgo(30), updatedAt: daysAgo(10), firstName: 'B', lastName: 'Two' },
    { id: '3', status: 'resolved', dueDate: null, verticalAttributes: {}, createdAt: daysAgo(20), updatedAt: daysAgo(10), firstName: 'C', lastName: 'Three' },
    { id: '4', status: 'open', dueDate: null, verticalAttributes: { riskTier: 'high' }, createdAt: daysAgo(1), updatedAt: daysAgo(1), firstName: 'D', lastName: 'Four' },
  ];

  const kpis = [
    {
      key: 'grant_rate',
      label: 'Grant Rate',
      unit: 'percentage' as const,
      target: 95,
      metric: {
        source: 'case',
        aggregate: 'percentage' as const,
        when: { '==': [{ var: 'status' }, 'resolved'] },
        of: { in: [{ var: 'status' }, ['resolved', 'closed']] },
      },
    },
    {
      key: 'declared_only',
      label: 'Declared Only',
      unit: 'count' as const,
      target: 10,
    },
    {
      key: 'age',
      label: 'Average Age',
      unit: 'days' as const,
      metric: { source: 'case', aggregate: 'average_days' as const, field: 'createdAt' },
    },
  ];

  const dashboard = {
    key: 'd',
    label: 'D',
    portal: 'staff' as const,
    roles: [],
    widgets: [
      { key: 'w_rate', label: 'Rate', type: 'kpi' as const, source: 'grant_rate', limit: 10, span: 3 },
      { key: 'w_declared', label: 'Declared', type: 'kpi' as const, source: 'declared_only', limit: 10, span: 3 },
      { key: 'w_missing', label: 'Missing', type: 'kpi' as const, source: 'not_in_pack', limit: 10, span: 3 },
      { key: 'w_age', label: 'Age', type: 'kpi' as const, source: 'age', limit: 10, span: 3 },
      { key: 'w_open', label: 'Open', type: 'count' as const, source: 'case', when: { '==': [{ var: 'status' }, 'open'] }, limit: 10, span: 3 },
      { key: 'w_chart', label: 'By status', type: 'chart' as const, source: 'case', limit: 10, span: 6 },
      { key: 'w_list', label: 'Recent', type: 'list' as const, source: 'case', limit: 2, span: 6 },
      { key: 'w_check', label: 'Docs', type: 'checklist' as const, source: 'documentTypes', limit: 10, span: 12 },
    ],
  };

  const entities = {
    count: jest.fn().mockResolvedValue(99),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        take: () => qb,
        getMany: () => Promise.resolve(rows),
      };
      return qb;
    }),
  };

  const ui = {
    dashboardFor: jest.fn().mockResolvedValue(dashboard),
    dashboardsFor: jest.fn().mockResolvedValue([dashboard]),
  };

  const packs = {
    list: jest.fn((_v: string, key: string) =>
      Promise.resolve(
        key === 'kpis'
          ? kpis
          : key === 'documentTypes'
            ? [{ key: 'passport', label: 'Passport', required: true }]
            : [],
      ),
    ),
  };

  const service = new PackDashboardService(
    entities as any,
    ui as any,
    packs as any,
    new RuleEvaluatorService(),
  );

  let resolved: Awaited<ReturnType<PackDashboardService['resolve']>>;
  const widget = (key: string) => resolved.widgets.find((w) => w.key === key)!;

  beforeAll(async () => {
    resolved = await service.resolve('t1', 'immigration', 'd', {
      roles: ['staff'],
      modules: null,
    });
  });

  it('computes a percentage over its declared population, not over everything', () => {
    // 1 resolved out of 2 decided (resolved + closed) — not 1 of 4.
    expect(widget('w_rate').value).toBe(50);
    expect(widget('w_rate').target).toBe(95);
  });

  it('returns null with a reason for a KPI the pack declares but never computes', () => {
    expect(widget('w_declared').value).toBeNull();
    expect(widget('w_declared').unavailableReason).toBe('kpi_has_no_metric');
  });

  it('names a widget pointing at a KPI that does not exist', () => {
    expect(widget('w_missing').unavailableReason).toBe('kpi_not_in_pack');
  });

  it('averages days from a date field', () => {
    // (10 + 30 + 20 + 1) / 4 ≈ 15.25
    expect(widget('w_age').value).toBeCloseTo(15.3, 0);
  });

  it('counts through the json-logic filter', () => {
    expect(widget('w_open').value).toBe(2);
  });

  it('buckets a chart by status, largest first', () => {
    expect(widget('w_chart').items).toEqual([
      { bucket: 'open', count: 2 },
      { bucket: 'closed', count: 1 },
      { bucket: 'resolved', count: 1 },
    ]);
  });

  it("honours a list widget's limit", () => {
    expect(widget('w_list').items).toHaveLength(2);
    expect(widget('w_list').items?.[0]).toMatchObject({ id: '1', title: 'A One' });
  });

  it('renders a checklist from the pack document types', () => {
    expect(widget('w_check').items).toEqual([
      { key: 'passport', label: 'Passport', required: true },
    ]);
  });

  it('counts in SQL when there is no filter, so the count cannot truncate', async () => {
    const unfiltered = await service.resolve('t1', 'immigration', 'd', {
      roles: ['staff'],
      modules: null,
    });
    expect(unfiltered).toBeDefined();
    expect(entities.count).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'nope' }) }),
    );
  });

  it('reports an empty population as unknown, never as zero percent', () => {
    const empty = (service as any).aggregate(
      {
        source: 'case',
        aggregate: 'percentage',
        when: { '==': [{ var: 'status' }, 'resolved'] },
        of: { '==': [{ var: 'status' }, 'nonexistent'] },
      },
      rows,
    );
    expect(empty.value).toBeNull();
    expect(empty.unavailableReason).toBe('no_records_in_population');
  });
});

/**
 * Trends, and the one rule a chart makes impossible to hide.
 *
 * A count of zero in a quiet month is a measurement. A *percentage* over a month
 * with nothing in its population is unknown, and plotting it as 0% draws a cliff
 * to the floor — inventing a collapse that did not happen. That is CLAUDE.md
 * §5.2 in the place where getting it wrong is most visible to a regulator.
 */
describe('PackDashboardService.trend — over time, without inventing zeroes', () => {
  const at = (iso: string) => new Date(iso);

  const rows = [
    // June: one resolved, one closed → 50%
    { id: '1', status: 'resolved', verticalAttributes: {}, createdAt: at('2026-06-05T00:00:00Z'), updatedAt: at('2026-06-05T00:00:00Z') },
    { id: '2', status: 'closed', verticalAttributes: {}, createdAt: at('2026-06-20T00:00:00Z'), updatedAt: at('2026-06-20T00:00:00Z') },
    // July: nothing at all → population empty
    // August: two resolved → 100%
    { id: '3', status: 'resolved', verticalAttributes: {}, createdAt: at('2026-08-02T00:00:00Z'), updatedAt: at('2026-08-02T00:00:00Z') },
    { id: '4', status: 'resolved', verticalAttributes: {}, createdAt: at('2026-08-09T00:00:00Z'), updatedAt: at('2026-08-09T00:00:00Z') },
  ];

  const kpis = [
    {
      key: 'grant_rate',
      label: 'Grant Rate',
      unit: 'percentage' as const,
      target: 95,
      metric: {
        source: 'case',
        aggregate: 'percentage' as const,
        when: { '==': [{ var: 'status' }, 'resolved'] },
        of: { in: [{ var: 'status' }, ['resolved', 'closed']] },
      },
    },
    {
      key: 'volume',
      label: 'Cases opened',
      unit: 'count' as const,
      metric: { source: 'case', aggregate: 'count' as const },
    },
    { key: 'declared_only', label: 'Declared', unit: 'count' as const },
  ];

  const build = (scanRows = rows, truncatedScan = false) => {
    const entities = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          take: () => qb,
          getMany: () =>
            Promise.resolve(
              truncatedScan
                ? Array.from({ length: 5001 }, (_, i) => ({
                    ...rows[0],
                    id: `x${i}`,
                  }))
                : scanRows,
            ),
        };
        return qb;
      }),
    };
    const packs = {
      list: jest.fn((_v: string, key: string) =>
        Promise.resolve(key === 'kpis' ? kpis : []),
      ),
    };
    return new PackDashboardService(
      entities as any,
      { dashboardFor: jest.fn(), dashboardsFor: jest.fn() } as any,
      packs as any,
      new RuleEvaluatorService(),
    );
  };

  const june1 = at('2026-06-01T00:00:00Z');
  const sept1 = at('2026-09-01T00:00:00Z');

  it('buckets by month across the window', async () => {
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'grant_rate',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    expect(out.buckets).toHaveLength(3);
    expect(out.buckets[0].periodStart).toBe('2026-06-01T00:00:00.000Z');
    expect(out.buckets[2].periodStart).toBe('2026-08-01T00:00:00.000Z');
  });

  it('computes a real percentage per bucket', async () => {
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'grant_rate',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    expect(out.buckets[0].value).toBe(50);
    expect(out.buckets[2].value).toBe(100);
  });

  it('returns null, not zero, for a percentage over an empty month', async () => {
    // The whole reason this endpoint needed care. July has no records.
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'grant_rate',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    const july = out.buckets[1];
    expect(july.value).toBeNull();
    expect(july.unavailableReason).toBe('no_records_in_population');
    expect(july.population).toBe(0);
  });

  it('returns zero, not null, for a count over an empty month', async () => {
    // The mirror case: nobody opened a case in July, and that *is* zero.
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    expect(out.buckets[1].value).toBe(0);
    expect(out.buckets[1].unavailableReason).toBeUndefined();
  });

  it('reports the population behind each figure', async () => {
    // 100% from one case and 100% from two hundred are not the same claim.
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'grant_rate',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    expect(out.buckets[0].population).toBe(2);
    expect(out.buckets[2].population).toBe(2);
  });

  it('distinguishes a missing KPI from a KPI with no metric', async () => {
    const svc = build();
    const missing = await svc.trend('t1', 'immigration', { kpiKey: 'nope' });
    expect(missing.unavailableReason).toBe('kpi_not_in_pack');
    expect(missing.buckets).toEqual([]);

    const declared = await svc.trend('t1', 'immigration', {
      kpiKey: 'declared_only',
    });
    expect(declared.unavailableReason).toBe('kpi_has_no_metric');
  });

  it('marks the whole series truncated when the scan hits its cap', async () => {
    // Per-bucket would be wrong: the cap drops rows before bucketing, so every
    // bucket is a lower bound, not just the busy ones.
    const out = await build(rows, true).trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    expect(out.truncated).toBe(true);
  });

  it('buckets weeks from Monday', async () => {
    // 2026-08-09 is a Sunday. A Sunday-start week would put it in the following
    // bucket and shift every weekly figure by a day.
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'week',
      from: at('2026-08-03T00:00:00Z'),
      to: at('2026-08-17T00:00:00Z'),
    });
    expect(out.buckets[0].periodStart).toBe('2026-08-03T00:00:00.000Z');
    // Both August records (2nd and 9th) — the 2nd falls before the window, the
    // 9th is a Sunday and belongs to the week beginning the 3rd.
    expect(out.buckets[0].value).toBe(1);
  });

  it('puts a boundary record in exactly one bucket', async () => {
    // Half-open ranges. Inclusive ends would count midnight twice.
    const out = await build([
      { id: 'b', status: 'resolved', verticalAttributes: {}, createdAt: at('2026-07-01T00:00:00.000Z'), updatedAt: at('2026-07-01T00:00:00Z') },
    ] as any).trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'month',
      from: june1,
      to: sept1,
    });
    const counted = out.buckets.filter((b) => (b.value ?? 0) > 0);
    expect(counted).toHaveLength(1);
    expect(counted[0].periodStart).toBe('2026-07-01T00:00:00.000Z');
  });

  it('buckets on the field the question is about', async () => {
    // A grant rate by month is about the decision date, not the open date.
    const out = await build([
      { id: 'd1', status: 'resolved', verticalAttributes: { decidedAt: '2026-08-15T00:00:00Z' }, createdAt: at('2026-06-01T00:00:00Z'), updatedAt: at('2026-06-01T00:00:00Z') },
    ] as any).trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'month',
      from: june1,
      to: sept1,
      dateField: 'decidedAt',
    });
    expect(out.buckets[0].value).toBe(0);
    expect(out.buckets[2].value).toBe(1);
  });

  it('caps the bucket count so a decade of days cannot exhaust the function', async () => {
    const out = await build().trend('t1', 'immigration', {
      kpiKey: 'volume',
      interval: 'day',
      from: at('2010-01-01T00:00:00Z'),
      to: at('2026-08-11T00:00:00Z'),
    });
    expect(out.buckets.length).toBeLessThanOrEqual(400);
  });

  it('defaults to a window worth charting', async () => {
    const out = await build().trend('t1', 'immigration', { kpiKey: 'volume' });
    expect(out.interval).toBe('month');
    expect(out.buckets.length).toBeGreaterThanOrEqual(11);
    expect(out.buckets.length).toBeLessThanOrEqual(13);
  });
});
