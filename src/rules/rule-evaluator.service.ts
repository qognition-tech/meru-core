import { Injectable, Logger } from '@nestjs/common';
import * as jsonLogic from 'json-logic-js';

/**
 * One evaluator for every condition a config pack can express.
 *
 * Three call sites need "is this true of this record?" — FORM validation,
 * WF transition conditions, and `alertRules.when` (docs/FEATURE_PARITY_MAP.md
 * §5). The alternative was three condition languages that disagree about what
 * `null` means, which is the kind of divergence nobody notices until a rule
 * behaves differently depending on which subsystem asked.
 *
 * JsonLogic rather than an expression string, and this is not a style
 * preference: a pack is authored by a non-engineer and read off disk at boot,
 * so an expression language with host access would be a sandbox escape with a
 * JSON file for a payload. JsonLogic has no host access by construction — it is
 * data. The worst a hostile rule can do is evaluate to the wrong boolean.
 */
@Injectable()
export class RuleEvaluatorService {
  private readonly logger = new Logger(RuleEvaluatorService.name);

  /**
   * Operators a pack may use. JsonLogic ships a few that read data from
   * outside the record it was handed, and a pack is untrusted input.
   *
   * The list is a whitelist rather than a blacklist on purpose: json-logic-js
   * lets callers register custom operations, and a blacklist would silently
   * admit anything added to the library later.
   */
  private static readonly ALLOWED_OPS = new Set([
    'var', 'missing', 'missing_some',
    'if', '==', '===', '!=', '!==', '!', '!!', 'or', 'and',
    '>', '>=', '<', '<=', 'max', 'min',
    '+', '-', '*', '/', '%',
    'map', 'filter', 'reduce', 'all', 'none', 'some',
    'merge', 'in', 'cat', 'substr',
  ]);

  /**
   * Check a rule compiles before anything depends on it.
   *
   * Called at load time so a malformed rule is rejected once, loudly, rather
   * than on the single record that happens to reach its bad branch — which in
   * a nightly sweep means an exception at 3am inside a loop over other
   * tenants' data.
   */
  validate(rule: unknown): { valid: true } | { valid: false; reason: string } {
    if (rule === null || rule === undefined) {
      return { valid: false, reason: 'rule is empty' };
    }

    const offending = this.findDisallowedOperator(rule);
    if (offending) {
      return {
        valid: false,
        reason: `operator '${offending}' is not permitted in a config pack rule`,
      };
    }

    try {
      // A dry run over an empty record. JsonLogic is total over missing data —
      // it returns null rather than throwing — so this catches structural
      // faults (a non-array argument to an operator that wants one), not
      // absent fields.
      jsonLogic.apply(rule as jsonLogic.RulesLogic, {});
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Evaluate a rule against a record, coerced to a boolean.
   *
   * Never throws. A rule that blows up returns `false`, because every caller
   * is asking "does this record match?" and the safe answer to a broken
   * question is "no" — the opposite default would alert on, or block, every
   * record in the tenant the moment a pack author typos an operator.
   */
  matches(rule: unknown, data: Record<string, unknown>): boolean {
    if (rule === null || rule === undefined) return false;

    try {
      return Boolean(
        jsonLogic.apply(rule as jsonLogic.RulesLogic, this.augment(data)),
      );
    } catch (err) {
      this.logger.warn(
        `Rule evaluation failed, treating as no-match: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  /**
   * As `matches`, but returns the raw value — for scoring factors and any
   * caller that wants a number or a string out of a rule.
   */
  evaluate(rule: unknown, data: Record<string, unknown>): unknown {
    if (rule === null || rule === undefined) return null;

    try {
      return jsonLogic.apply(rule as jsonLogic.RulesLogic, this.augment(data));
    } catch (err) {
      this.logger.warn(
        `Rule evaluation failed, returning null: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  /**
   * Add the variables date rules need.
   *
   * "30 days before expiry" is the single most common rule either vertical
   * wants, and expressing it in raw JsonLogic means subtracting epoch
   * milliseconds inside nested arrays — unreadable, and unreviewable by the
   * domain author who is supposed to own these packs. So every date-valued
   * field `x` gains `x_daysUntil` and `x_daysSince`, and `_now` is available
   * as an ISO string.
   *
   * Both are computed in whole days from the same instant, so a rule cannot
   * see `daysUntil: 30` and `daysSince: -29` in one pass.
   */
  augment(
    data: Record<string, unknown>,
    now: Date = new Date(),
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...data, _now: now.toISOString() };

    for (const [key, value] of Object.entries(data)) {
      const date = this.asDate(value);
      if (!date) continue;

      const days = Math.floor(
        (date.getTime() - now.getTime()) / 86_400_000,
      );
      out[`${key}_daysUntil`] = days;
      out[`${key}_daysSince`] = -days;
    }

    // Vertical fields live in a jsonb blob, so a rule author writing
    // `{"var": "visaExpiry"}` would otherwise have to know it is really
    // `verticalAttributes.visaExpiry`. Flattened one level, and top-level
    // columns win a collision — a pack must not be able to shadow `status` or
    // `dueDate` by naming a vertical attribute the same thing.
    const vertical = data.verticalAttributes;
    if (vertical && typeof vertical === 'object' && !Array.isArray(vertical)) {
      for (const [key, value] of Object.entries(
        vertical as Record<string, unknown>,
      )) {
        if (key in out) continue;
        out[key] = value;

        const date = this.asDate(value);
        if (!date) continue;
        const days = Math.floor((date.getTime() - now.getTime()) / 86_400_000);
        out[`${key}_daysUntil`] = days;
        out[`${key}_daysSince`] = -days;
      }
    }

    return out;
  }

  /**
   * A Date, or a string that is unambiguously one — ISO 8601 only.
   *
   * Deliberately not `new Date(anyString)`: that parses "1" and "Sat" into
   * dates, so a free-text field would sprout `_daysUntil` variables and a
   * rule could silently match on garbage.
   */
  private asDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value)) return null;

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /** Walks the rule tree and returns the first operator not on the whitelist. */
  private findDisallowedOperator(rule: unknown): string | null {
    if (Array.isArray(rule)) {
      for (const item of rule) {
        const found = this.findDisallowedOperator(item);
        if (found) return found;
      }
      return null;
    }

    if (rule === null || typeof rule !== 'object') return null;

    for (const [op, args] of Object.entries(rule as Record<string, unknown>)) {
      if (!RuleEvaluatorService.ALLOWED_OPS.has(op)) return op;
      const found = this.findDisallowedOperator(args);
      if (found) return found;
    }

    return null;
  }
}
