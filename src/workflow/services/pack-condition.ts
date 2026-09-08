/**
 * Compiles a pack workflow `condition` string into JsonLogic.
 *
 * Pack authors write `matter.subclass in ['500','485']` or
 * `screening.riskLevel !== 'critical'`. That is not evaluated as code —
 * CLAUDE.md §6 rule 3, no `eval` — so the grammar here is deliberately tiny
 * and anything outside it compiles to nothing, which `WorkflowEngineService`
 * treats as "this transition is not evaluable" rather than "this transition
 * is allowed".
 *
 * Grammar (whitespace-insensitive):
 *   <path> <op> <literal>          op ∈ === !== == != > >= < <=
 *   <path> in [<literal>, …]
 *   <path> not in [<literal>, …]
 *   a JSON object                  taken verbatim as JsonLogic
 *
 * `<path>` is dotted identifiers; `<literal>` is a single- or double-quoted
 * string, a number, true, false or null.
 */
export interface CompiledCondition {
  jsonLogic: unknown;
  source: string;
}

export type CompileResult =
  | { ok: true; compiled: CompiledCondition }
  | { ok: false; reason: string };

const PATH = String.raw`([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)`;
const LITERAL = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)`;
const COMPARISON = new RegExp(
  `^\\s*${PATH}\\s*(===|!==|==|!=|>=|<=|>|<)\\s*${LITERAL}\\s*$`,
);
const MEMBERSHIP = new RegExp(
  `^\\s*${PATH}\\s+(not\\s+in|in)\\s*\\[([^\\]]*)\\]\\s*$`,
);
const LITERAL_ONLY = new RegExp(`^\\s*${LITERAL}\\s*$`);

function literal(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const quote = t[0];
  if ((quote === "'" || quote === '"') && t.endsWith(quote)) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  throw new Error(`not a literal: ${raw}`);
}

export function compileCondition(source: string | undefined): CompileResult {
  if (source === undefined || source.trim() === '') {
    return { ok: true, compiled: { jsonLogic: true, source: '' } };
  }
  const text = source.trim();

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, compiled: { jsonLogic: parsed, source } };
      }
      return { ok: false, reason: 'JSON condition must be an object' };
    } catch (e) {
      return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
    }
  }

  const cmp = COMPARISON.exec(text);
  if (cmp) {
    const [, path, op, lit] = cmp;
    try {
      return {
        ok: true,
        compiled: { jsonLogic: { [op]: [{ var: path }, literal(lit)] }, source },
      };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  const mem = MEMBERSHIP.exec(text);
  if (mem) {
    const [, path, op, list] = mem;
    try {
      const values = list
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          if (!LITERAL_ONLY.test(s)) throw new Error(`not a literal: ${s}`);
          return literal(s);
        });
      const inClause = { in: [{ var: path }, values] };
      return {
        ok: true,
        compiled: {
          jsonLogic: op.startsWith('not') ? { '!': inClause } : inClause,
          source,
        },
      };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  return {
    ok: false,
    reason:
      'unsupported condition syntax; use `<path> <op> <literal>`, ' +
      '`<path> in [...]`, `<path> not in [...]`, or a JsonLogic object',
  };
}
