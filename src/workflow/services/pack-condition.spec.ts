import { compileCondition } from './pack-condition';

describe('compileCondition', () => {
  it('compiles the three forms the packs actually use', () => {
    expect(compileCondition("screening.riskLevel !== 'critical'")).toEqual({
      ok: true,
      compiled: {
        jsonLogic: { '!==': [{ var: 'screening.riskLevel' }, 'critical'] },
        source: "screening.riskLevel !== 'critical'",
      },
    });
    expect(compileCondition("matter.subclass in ['500','485']")).toMatchObject({
      ok: true,
      compiled: { jsonLogic: { in: [{ var: 'matter.subclass' }, ['500', '485']] } },
    });
    expect(compileCondition("matter.subclass not in ['500','600']")).toMatchObject({
      ok: true,
      compiled: {
        jsonLogic: { '!': { in: [{ var: 'matter.subclass' }, ['500', '600']] } },
      },
    });
  });

  it('accepts numbers, booleans and JsonLogic verbatim', () => {
    expect(compileCondition('fees.paid >= 1500')).toMatchObject({
      ok: true,
      compiled: { jsonLogic: { '>=': [{ var: 'fees.paid' }, 1500] } },
    });
    expect(compileCondition('{"and":[true,false]}')).toMatchObject({
      ok: true,
      compiled: { jsonLogic: { and: [true, false] } },
    });
  });

  it('treats an empty condition as always-true', () => {
    expect(compileCondition(undefined)).toMatchObject({ ok: true });
    expect(compileCondition('  ')).toMatchObject({ ok: true });
  });

  it('refuses anything that looks like code', () => {
    for (const bad of [
      'process.exit()',
      'a === b',
      "require('fs')",
      'x > 1 && y < 2',
      '[1,2]',
    ]) {
      expect(compileCondition(bad).ok).toBe(false);
    }
  });
});
