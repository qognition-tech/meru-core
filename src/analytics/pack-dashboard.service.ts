import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import {
  DashboardDefinition,
  DashboardWidgetDefinition,
  PackUiService,
  UiAudience,
} from '../tenant/services/pack-ui.service';

/** One `kpis[]` entry, including the optional `metric` that computes it. */
export interface KpiDefinition {
  key: string;
  label: string;
  unit: 'count' | 'percentage' | 'days' | 'hours' | 'currency' | 'score';
  target?: number;
  alert?: { threshold: number; direction: 'above' | 'below' };
  metric?: {
    source: string;
    aggregate: 'count' | 'percentage' | 'average_days' | 'sum';
    when?: unknown;
    of?: unknown;
    field?: string;
    until?: string;
  };
}

/** One `documentTypes[]` entry, as far as a checklist widget cares. */
interface DocumentTypeDefinition {
  key: string;
  label: string;
  required?: boolean;
}

export interface ResolvedWidget {
  key: string;
  label: string;
  type: DashboardWidgetDefinition['type'];
  source: string;
  span: number;
  /** A single number for `kpi`/`count`, otherwise null. */
  value: number | null;
  unit?: KpiDefinition['unit'];
  target?: number | null;
  /** Rows for `list`, buckets for `chart`, document types for `checklist`. */
  items?: Array<Record<string, unknown>>;
  /**
   * Why there is no value. Present exactly when `value` is null and the widget
   * is one that should have had one. The frontends already treat this field as
   * the signal to render grey-unknown rather than a zero — see the vessel
   * adapter, where `unavailableReason` is the thing that stops "we cannot see
   * this" from rendering as "there is nothing to see".
   */
  unavailableReason?: string;
  /**
   * How many rows were read to compute this, and whether the scan hit its cap.
   * A truncated count is a lower bound, and a UI that cannot tell the
   * difference will state a wrong number with total confidence.
   */
  scanned?: number;
  truncated?: boolean;
}

export interface ResolvedDashboard {
  key: string;
  label: string;
  portal: string;
  widgets: ResolvedWidget[];
  generatedAt: string;
}

/**
 * Computes the numbers behind a pack-declared dashboard.
 *
 * TCM owns the dashboard *definition* (`PackUiService`); this owns the
 * arithmetic, because reading a tenant's entities is BI's job and not
 * configuration's. The split matters for the same reason the four-layer model
 * does: a pack author changes a widget's filter, and nothing in core changes.
 *
 * The hard constraint is that a widget's `when` is JsonLogic, which Postgres
 * cannot execute. So the filter runs in this process over rows the database
 * narrowed by tenant and entity type — both indexed. That is fine at the scale
 * a firm's dashboard actually queries and dishonest at the scale it might one
 * day, so every scan is capped and a capped scan says so.
 */
@Injectable()
export class PackDashboardService {
  private readonly logger = new Logger(PackDashboardService.name);

  /**
   * Rows one widget may read.
   *
   * Chosen so the worst case (a six-widget dashboard, every widget filtered)
   * stays inside a serverless invocation's budget. Beyond it the widget
   * reports `truncated`, which the UI renders as "5,000+" — a number that is
   * wrong in a direction the reader can see, rather than one that is wrong
   * silently.
   */
  private static readonly MAX_SCAN = 5_000;

  /** Rows a `list` widget returns regardless of what the pack asks for. */
  private static readonly MAX_LIST = 50;

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entities: Repository<UniversalEntity>,
    private readonly ui: PackUiService,
    private readonly packs: VerticalPackService,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  /** Definitions only — what the caller may open. */
  async list(
    vertical: string | null,
    audience: UiAudience,
  ): Promise<DashboardDefinition[]> {
    return this.ui.dashboardsFor(vertical, audience);
  }

  /** One dashboard, with every widget resolved against the tenant's data. */
  async resolve(
    tenantId: string,
    vertical: string | null,
    key: string,
    audience: UiAudience,
  ): Promise<ResolvedDashboard> {
    const dashboard = await this.ui.dashboardFor(vertical, key, audience);
    const kpis = await this.packs.list<KpiDefinition>(vertical, 'kpis');
    const documentTypes = await this.packs.list<DocumentTypeDefinition>(
      vertical,
      'documentTypes',
    );

    const widgets: ResolvedWidget[] = [];
    for (const widget of dashboard.widgets ?? []) {
      widgets.push(
        await this.resolveWidget(tenantId, widget, kpis, documentTypes),
      );
    }

    return {
      key: dashboard.key,
      label: dashboard.label,
      portal: dashboard.portal ?? 'staff',
      widgets,
      generatedAt: new Date().toISOString(),
    };
  }

  private async resolveWidget(
    tenantId: string,
    widget: DashboardWidgetDefinition,
    kpis: KpiDefinition[],
    documentTypes: DocumentTypeDefinition[],
  ): Promise<ResolvedWidget> {
    const base: ResolvedWidget = {
      key: widget.key,
      label: widget.label,
      type: widget.type,
      source: widget.source,
      span: widget.span ?? 4,
      value: null,
    };

    try {
      switch (widget.type) {
        case 'kpi':
          return await this.resolveKpi(tenantId, base, widget, kpis);
        case 'count':
          return await this.resolveCount(tenantId, base, widget);
        case 'list':
          return await this.resolveList(tenantId, base, widget);
        case 'chart':
          return await this.resolveChart(tenantId, base, widget);
        case 'checklist':
          return {
            ...base,
            items: documentTypes.map((d) => ({
              key: d.key,
              label: d.label,
              required: d.required ?? false,
            })),
          };
        default:
          return { ...base, unavailableReason: 'unknown_widget_type' };
      }
    } catch (err) {
      // One bad widget must not take the dashboard down with it. The pack is
      // authored by a domain expert, and a typo in one filter should cost that
      // tile, not the page.
      this.logger.warn(
        `Widget '${widget.key}' failed to resolve: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { ...base, unavailableReason: 'widget_failed' };
    }
  }

  /**
   * The same KPI, measured repeatedly over time.
   *
   * BI was point-in-time only, so every "rate" question — is our grant rate
   * improving, is turnaround getting worse — had no endpoint behind it. A trend
   * is the existing KPI machinery run once per bucket, which is why it lives
   * here rather than in a second service with its own copy of `aggregate`.
   *
   * The null-versus-zero rule matters more here than anywhere, because a chart
   * makes the difference visible. A count of zero in a quiet month is a real
   * measurement and is plotted as zero. A *percentage* over an empty month is
   * unknown — plotting it as 0% draws a cliff to the floor and invents a
   * collapse that did not happen (CLAUDE.md §5.2). That falls out of reusing
   * `aggregate`, which already refuses zero-over-zero.
   */
  async trend(
    tenantId: string,
    vertical: string | null,
    options: {
      kpiKey: string;
      interval?: 'day' | 'week' | 'month';
      from?: Date;
      to?: Date;
      /** Which date buckets a row. Defaults to `createdAt`. */
      dateField?: string;
    },
  ): Promise<{
    kpi: string;
    label: string;
    unit?: KpiDefinition['unit'];
    target: number | null;
    interval: 'day' | 'week' | 'month';
    dateField: string;
    from: string;
    to: string;
    unavailableReason?: string;
    truncated?: boolean;
    scanned?: number;
    buckets: Array<{
      periodStart: string;
      periodEnd: string;
      value: number | null;
      population: number;
      unavailableReason?: string;
    }>;
  }> {
    const interval = options.interval ?? 'month';
    const dateField = options.dateField ?? 'createdAt';
    const to = options.to ?? new Date();
    const from = options.from ?? defaultFrom(to, interval);

    const kpis = await this.packs.list<KpiDefinition>(vertical, 'kpis');
    const kpi = kpis.find((k) => k.key === options.kpiKey);

    const shell = {
      kpi: options.kpiKey,
      label: kpi?.label ?? options.kpiKey,
      unit: kpi?.unit,
      target: kpi?.target ?? null,
      interval,
      dateField,
      from: from.toISOString(),
      to: to.toISOString(),
      buckets: [] as Array<{
        periodStart: string;
        periodEnd: string;
        value: number | null;
        population: number;
        unavailableReason?: string;
      }>,
    };

    // The same three distinct nulls as a KPI tile, for the same reason: only one
    // of them is a bug, and a caller that cannot tell them apart cannot report
    // them usefully.
    if (!kpi) return { ...shell, unavailableReason: 'kpi_not_in_pack' };
    if (!kpi.metric) return { ...shell, unavailableReason: 'kpi_has_no_metric' };

    const { rows, truncated } = await this.scan(tenantId, kpi.metric.source);

    const periods = buildPeriods(from, to, interval);
    const buckets = periods.map((period) => {
      const inPeriod = rows.filter((row) => {
        const at = this.asDate(this.field(row, dateField));
        return !!at && at >= period.start && at < period.end;
      });

      const computed = this.aggregate(kpi.metric!, inPeriod);

      return {
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        value: computed.value,
        // How many rows the bucket was computed from. A reader needs this to
        // know whether a spike is a trend or one case in a quiet week.
        population: inPeriod.length,
        unavailableReason: computed.unavailableReason,
      };
    });

    return {
      ...shell,
      // A truncated scan makes every bucket a lower bound, so it is reported on
      // the series rather than per bucket — the caller must not plot any of it
      // as exact.
      truncated,
      scanned: rows.length,
      buckets,
    };
  }

  /**
   * A KPI tile.
   *
   * Three distinct nulls, each with its own reason, because "no number" has
   * three very different causes and only one of them is a bug: the pack names
   * a KPI that does not exist, the KPI exists but declares no metric, or the
   * metric ran and its denominator was empty.
   */
  private async resolveKpi(
    tenantId: string,
    base: ResolvedWidget,
    widget: DashboardWidgetDefinition,
    kpis: KpiDefinition[],
  ): Promise<ResolvedWidget> {
    const kpi = kpis.find((k) => k.key === widget.source);
    if (!kpi) {
      return { ...base, unavailableReason: 'kpi_not_in_pack' };
    }

    const out: ResolvedWidget = {
      ...base,
      label: widget.label || kpi.label,
      unit: kpi.unit,
      target: kpi.target ?? null,
    };

    if (!kpi.metric) {
      return { ...out, unavailableReason: 'kpi_has_no_metric' };
    }

    const { rows, truncated } = await this.scan(tenantId, kpi.metric.source);
    const computed = this.aggregate(kpi.metric, rows);

    return {
      ...out,
      value: computed.value,
      unavailableReason: computed.unavailableReason,
      scanned: rows.length,
      truncated,
    };
  }

  private async resolveCount(
    tenantId: string,
    base: ResolvedWidget,
    widget: DashboardWidgetDefinition,
  ): Promise<ResolvedWidget> {
    // No filter means the database can count without sending rows, which is
    // both faster and exact — a `count` widget with no `when` never truncates.
    if (widget.when === undefined || widget.when === null) {
      const value = await this.entities.count({
        where: { tenantId, type: widget.source as UniversalEntity['type'] },
      });
      return { ...base, value, unit: 'count', truncated: false };
    }

    const { rows, truncated } = await this.scan(tenantId, widget.source);
    const value = rows.filter((r) => this.matches(widget.when, r)).length;

    return { ...base, value, unit: 'count', scanned: rows.length, truncated };
  }

  private async resolveList(
    tenantId: string,
    base: ResolvedWidget,
    widget: DashboardWidgetDefinition,
  ): Promise<ResolvedWidget> {
    const { rows, truncated } = await this.scan(tenantId, widget.source);
    const limit = Math.min(widget.limit ?? 10, PackDashboardService.MAX_LIST);

    const items = rows
      .filter((r) => this.matches(widget.when, r))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: this.title(r),
        status: r.status,
        dueDate: r.dueDate,
        assignedTo: r.assignedTo,
        updatedAt: r.updatedAt,
      }));

    return { ...base, items, scanned: rows.length, truncated };
  }

  /**
   * A chart bucket count.
   *
   * `status` is the default dimension because it is the one field every
   * workable entity type has. A `groupBy` naming a missing field buckets into
   * `unset` rather than vanishing — a chart that silently drops rows misstates
   * a total, which is worse than one that shows an honest `unset` slice.
   */
  private async resolveChart(
    tenantId: string,
    base: ResolvedWidget,
    widget: DashboardWidgetDefinition,
  ): Promise<ResolvedWidget> {
    const { rows, truncated } = await this.scan(tenantId, widget.source);
    const field = widget.groupBy ?? 'status';

    const buckets = new Map<string, number>();
    for (const row of rows) {
      if (!this.matches(widget.when, row)) continue;
      const raw = this.field(row, field);
      const bucket =
        raw === null || raw === undefined || raw === '' ? 'unset' : String(raw);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }

    const items = [...buckets.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count);

    return { ...base, items, scanned: rows.length, truncated };
  }

  /** Apply one `metric` to the rows it was computed over. */
  private aggregate(
    metric: NonNullable<KpiDefinition['metric']>,
    rows: UniversalEntity[],
  ): { value: number | null; unavailableReason?: string } {
    const numerator = rows.filter((r) => this.matches(metric.when, r));

    switch (metric.aggregate) {
      case 'count':
        return { value: numerator.length };

      case 'percentage': {
        const denominator =
          metric.of === undefined || metric.of === null
            ? rows
            : rows.filter((r) => this.matches(metric.of, r));

        // Zero over zero is not zero percent. A grant rate with no decided
        // cases is unknown, and rendering 0% against a 95% target invents a
        // failure that has not happened.
        if (denominator.length === 0) {
          return { value: null, unavailableReason: 'no_records_in_population' };
        }

        return {
          value:
            Math.round((numerator.length / denominator.length) * 1000) / 10,
        };
      }

      case 'sum': {
        if (!metric.field) {
          return { value: null, unavailableReason: 'metric_missing_field' };
        }
        let total = 0;
        for (const row of numerator) {
          const raw = this.field(row, metric.field);
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (Number.isFinite(n)) total += n;
        }
        return { value: Math.round(total * 100) / 100 };
      }

      case 'average_days': {
        if (!metric.field) {
          return { value: null, unavailableReason: 'metric_missing_field' };
        }

        const spans: number[] = [];
        for (const row of numerator) {
          const from = this.asDate(this.field(row, metric.field));
          if (!from) continue;
          const to = metric.until
            ? this.asDate(this.field(row, metric.until))
            : new Date();
          if (!to) continue;
          spans.push((to.getTime() - from.getTime()) / 86_400_000);
        }

        if (spans.length === 0) {
          return { value: null, unavailableReason: 'no_dated_records' };
        }

        const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
        return { value: Math.round(mean * 10) / 10 };
      }

      default:
        return { value: null, unavailableReason: 'unknown_aggregate' };
    }
  }

  /**
   * Read at most `MAX_SCAN` rows of one entity type for this tenant.
   *
   * Newest first, so a truncated scan holds the rows a dashboard is most
   * likely to be about. RLS scopes the read on the connection; the explicit
   * `tenantId` predicate is belt-and-braces and keeps the index in play.
   */
  private async scan(
    tenantId: string,
    entityType: string,
  ): Promise<{ rows: UniversalEntity[]; truncated: boolean }> {
    const rows = await this.entities
      .createQueryBuilder('e')
      .where('e."tenantId" = :tenantId', { tenantId })
      .andWhere('e.type = :type', { type: entityType })
      .andWhere('e."deletedAt" IS NULL')
      .orderBy('e."updatedAt"', 'DESC')
      .take(PackDashboardService.MAX_SCAN + 1)
      .getMany();

    const truncated = rows.length > PackDashboardService.MAX_SCAN;
    return {
      rows: truncated ? rows.slice(0, PackDashboardService.MAX_SCAN) : rows,
      truncated,
    };
  }

  /** An absent filter matches everything; a present one goes to JsonLogic. */
  private matches(when: unknown, row: UniversalEntity): boolean {
    if (when === undefined || when === null) return true;
    return this.evaluator.matches(when, row as unknown as Record<string, unknown>);
  }

  /** A top-level column, or a `verticalAttributes` key. */
  private field(row: UniversalEntity, name: string): unknown {
    const direct = (row as unknown as Record<string, unknown>)[name];
    if (direct !== undefined) return direct;
    return (row.verticalAttributes ?? {})[name];
  }

  /** Best available human label for a list row. */
  private title(row: UniversalEntity): string {
    const attrs = row.verticalAttributes ?? {};
    const named = [attrs.title, attrs.name, attrs.reference].find(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    if (named) return named as string;

    const person = [row.firstName, row.lastName].filter(Boolean).join(' ');
    return person || row.email || row.id;
  }

  /** ISO-8601 only, for the same reason the rule evaluator insists on it. */
  private asDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value)) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

// ── Time bucketing ──────────────────────────────────────────────────────────

/**
 * How far back a trend reaches when the caller does not say.
 *
 * Chosen so each interval returns a chart worth looking at rather than a single
 * point or a thousand of them.
 */
function defaultFrom(to: Date, interval: 'day' | 'week' | 'month'): Date {
  const from = new Date(to);
  if (interval === 'day') from.setUTCDate(from.getUTCDate() - 29);
  else if (interval === 'week') from.setUTCDate(from.getUTCDate() - 7 * 11);
  else from.setUTCMonth(from.getUTCMonth() - 11);
  return from;
}

/**
 * Half-open buckets `[start, end)` covering `from`..`to`.
 *
 * Half-open so a record on a boundary lands in exactly one bucket. Inclusive
 * ends would double-count midnight, which shows up as a phantom duplicate in
 * whichever bucket a reader looks at second.
 *
 * All arithmetic is UTC. Local-time bucketing shifts every boundary by the
 * server's offset, so the same data would bucket differently depending on where
 * the function happened to run — and Vercel runs this in `sin1`.
 */
function buildPeriods(
  from: Date,
  to: Date,
  interval: 'day' | 'week' | 'month',
): Array<{ start: Date; end: Date }> {
  const periods: Array<{ start: Date; end: Date }> = [];
  let cursor = truncateTo(from, interval);
  let guard = 0;

  while (cursor < to && guard < MAX_BUCKETS) {
    const end = advance(cursor, interval);
    periods.push({ start: cursor, end });
    cursor = end;
    guard += 1;
  }

  return periods;
}

/** Cap on buckets, so a decade-wide `?interval=day` cannot exhaust the function. */
const MAX_BUCKETS = 400;

function truncateTo(date: Date, interval: 'day' | 'week' | 'month'): Date {
  const out = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  if (interval === 'month') {
    return new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth(), 1));
  }
  if (interval === 'week') {
    // ISO weeks start Monday. `getUTCDay()` calls Sunday 0, so Sunday steps back
    // six days rather than one.
    const day = out.getUTCDay();
    const back = day === 0 ? 6 : day - 1;
    out.setUTCDate(out.getUTCDate() - back);
  }
  return out;
}

function advance(date: Date, interval: 'day' | 'week' | 'month'): Date {
  const out = new Date(date);
  if (interval === 'day') out.setUTCDate(out.getUTCDate() + 1);
  else if (interval === 'week') out.setUTCDate(out.getUTCDate() + 7);
  else out.setUTCMonth(out.getUTCMonth() + 1);
  return out;
}
