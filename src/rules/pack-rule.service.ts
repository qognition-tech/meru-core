import { Injectable, Logger } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';

/** One entry of a pack's `rules[]` — see `RuleSchema` in pack.schema.ts. */
export interface PackRuleDefinition {
  key: string;
  label: string;
  description?: string;
  when: unknown;
  message?: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface PackRuleViolation {
  key: string;
  label: string;
  severity: 'info' | 'warning' | 'error';
  message: string | null;
}

export interface PackRuleReport {
  /** The pack the rules came from, so a wrong answer can be traced. */
  pack: { code: string; version: string } | null;
  /** Rules that compiled and were evaluated against the record. */
  evaluated: number;
  /** Rules whose `when` could not compile. Authoring errors, never silent. */
  invalid: { key: string; reason: string }[];
  /** Rules the evaluator refused because the record lacks a compared field. */
  skipped: { key: string; reason: string }[];
  violations: PackRuleViolation[];
  /** True when at least one `error`-severity rule matched. */
  blocked: boolean;
}

/**
 * Evaluates a pack's declarative `rules[]` against one record.
 *
 * `rules[]` was validated by Zod, persisted by the loader, and then read by
 * nothing — the tenth pack array, and the only one with no consumer. This is
 * the consumer. It is read-only and additive: it reports, it does not block a
 * write, because a rule that silently refuses a PATCH on an ImmiStack tenant
 * is exactly the cross-vertical breakage CLAUDE.md §7.2 forbids. A UI reads
 * the report and greys out the button; a workflow transition may consult
 * `blocked` when a pack asks for it.
 *
 * Evaluation goes through `RuleEvaluatorService`, which refuses a numeric
 * comparison against a variable the record does not carry. Those refusals
 * are returned as `skipped`, not as "passed" — an unevaluated rule is unknown,
 * and unknown must never render as clean (CLAUDE.md §7.3).
 */
@Injectable()
export class PackRuleService {
  private readonly logger = new Logger(PackRuleService.name);

  constructor(
    private readonly packs: VerticalPackService,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  async evaluate(
    vertical: string | null,
    record: Record<string, unknown>,
  ): Promise<PackRuleReport> {
    const { pack, section } = await this.packs.sectionWithPack<
      PackRuleDefinition[]
    >(vertical, 'rules');

    const report: PackRuleReport = {
      pack: pack ? { code: pack.code, version: pack.version } : null,
      evaluated: 0,
      invalid: [],
      skipped: [],
      violations: [],
      blocked: false,
    };

    const rules = Array.isArray(section) ? section : [];
    // Promote `verticalAttributes.*` to the top level so a rule can say
    // `{"var":"visaExpiry"}` rather than `{"var":"verticalAttributes.visaExpiry"}`,
    // matching what alert rules already see. Top-level columns win on clash.
    const attrs =
      (record.verticalAttributes as Record<string, unknown> | undefined) ?? {};
    const data: Record<string, unknown> = { ...attrs, ...record };

    for (const rule of rules) {
      const check = this.evaluator.validate(rule.when);
      if (!check.valid) {
        report.invalid.push({ key: rule.key, reason: check.reason });
        this.logger.error(
          `Pack rule '${rule.key}' is not evaluable and was skipped: ${check.reason}`,
        );
        continue;
      }

      const missing = this.missingVariables(rule.when, data);
      if (missing.length) {
        report.skipped.push({
          key: rule.key,
          reason: `record does not carry ${missing.join(', ')}`,
        });
        continue;
      }

      report.evaluated++;
      if (!this.evaluator.matches(rule.when, data)) continue;

      const severity = rule.severity ?? 'error';
      report.violations.push({
        key: rule.key,
        label: rule.label,
        severity,
        message: rule.message ? this.render(rule.message, data) : null,
      });
      if (severity === 'error') report.blocked = true;
    }

    return report;
  }

  /** `{{field}}` placeholders, resolved against the record; unknowns stay literal. */
  private render(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path: string) => {
      const value = path
        .split('.')
        .reduce<unknown>(
          (acc, k) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[k]
              : undefined,
          data,
        );
      return value === undefined || value === null ? whole : String(value);
    });
  }

  /** Every `{"var": "x"}` the rule reads that the record does not define. */
  private missingVariables(
    rule: unknown,
    data: Record<string, unknown>,
  ): string[] {
    const vars = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if ('var' in obj && Object.keys(obj).length === 1) {
        const v = obj.var;
        const name = Array.isArray(v) ? v[0] : v;
        if (typeof name === 'string') vars.add(name);
        return;
      }
      Object.values(obj).forEach(walk);
    };
    walk(rule);

    return [...vars].filter((name) => {
      const value = name
        .split('.')
        .reduce<unknown>(
          (acc, k) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[k]
              : undefined,
          data,
        );
      return value === undefined;
    });
  }
}
