import { RuleEvaluatorService } from './rule-evaluator.service';

describe('RuleEvaluatorService', () => {
  const evaluator = new RuleEvaluatorService();

  describe('validate', () => {
    it('accepts an ordinary comparison', () => {
      expect(evaluator.validate({ '<': [{ var: 'age' }, 18] })).toEqual({
        valid: true,
      });
    });

    it('refuses an operator that is not on the whitelist', () => {
      // json-logic-js allows callers to register custom operations, so the
      // guard is a whitelist. A pack is untrusted input: it is authored
      // outside engineering and read off disk at boot.
      const result = evaluator.validate({ exec: ['rm -rf /'] });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('exec');
    });

    it('finds a disallowed operator nested inside an allowed one', () => {
      const result = evaluator.validate({
        and: [{ '>': [{ var: 'x' }, 1] }, { fetch: ['http://evil'] }],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('fetch');
    });

    it('refuses an empty rule', () => {
      expect(evaluator.validate(undefined).valid).toBe(false);
      expect(evaluator.validate(null).valid).toBe(false);
    });
  });

  describe('matches', () => {
    it('reads a top-level field', () => {
      expect(evaluator.matches({ '==': [{ var: 'status' }, 'open'] }, { status: 'open' })).toBe(true);
      expect(evaluator.matches({ '==': [{ var: 'status' }, 'open'] }, { status: 'closed' })).toBe(false);
    });

    it('treats a broken rule as no-match rather than throwing', () => {
      // Every caller is asking "does this record match?". The safe answer to a
      // broken question is "no": the opposite default would alert on, or block,
      // every record in the tenant the moment an author typos an operator.
      expect(evaluator.matches({ '<': 'not-an-array' }, { age: 5 })).toBe(false);
    });

    it('does not match on a missing field', () => {
      expect(evaluator.matches({ '==': [{ var: 'missing' }, 'x'] }, {})).toBe(false);
    });
  });

  describe('date variables', () => {
    const now = new Date('2026-08-10T12:00:00Z');

    it('exposes _daysUntil for a future date', () => {
      const data = evaluator.augment({ visaExpiry: '2026-09-09T12:00:00Z' }, now);
      expect(data.visaExpiry_daysUntil).toBe(30);
      expect(data.visaExpiry_daysSince).toBe(-30);
    });

    it('exposes _daysSince for a past date', () => {
      const data = evaluator.augment({ lodgedAt: '2026-07-11T12:00:00Z' }, now);
      expect(data.lodgedAt_daysSince).toBe(30);
    });

    it('drives the rule the packs actually need', () => {
      const rule = { '<': [{ var: 'visaExpiry_daysUntil' }, 30] };
      expect(
        evaluator.matches(rule, {
          visaExpiry: new Date('2026-08-20T12:00:00Z'),
        }),
      ).toBe(true);
    });

    it('ignores free text that Date would otherwise parse', () => {
      // `new Date('Sat')` and `new Date('1')` are valid dates. Without the ISO
      // guard a free-text field would sprout _daysUntil variables and a rule
      // could match on garbage.
      const data = evaluator.augment({ note: 'Sat', reference: '1' }, now);
      expect(data.note_daysUntil).toBeUndefined();
      expect(data.reference_daysUntil).toBeUndefined();
    });
  });

  describe('verticalAttributes flattening', () => {
    it('lets a rule name a vertical field directly', () => {
      // Otherwise a pack author has to know that `visaSubclass` is really
      // `verticalAttributes.visaSubclass` — an implementation detail of core's
      // polymorphic entity table.
      expect(
        evaluator.matches({ '==': [{ var: 'visaSubclass' }, '482'] }, {
          verticalAttributes: { visaSubclass: '482' },
        }),
      ).toBe(true);
    });

    it('does not let a vertical attribute shadow a real column', () => {
      // A pack must not be able to redefine `status` for rules that other
      // parts of core rely on meaning the lifecycle column.
      const data = evaluator.augment({
        status: 'open',
        verticalAttributes: { status: 'closed' },
      });
      expect(data.status).toBe('open');
    });

    it('computes date variables for vertical date fields too', () => {
      const data = evaluator.augment(
        { verticalAttributes: { passportExpiry: '2026-08-20' } },
        new Date('2026-08-10T00:00:00Z'),
      );
      expect(data.passportExpiry_daysUntil).toBe(10);
    });
  });
});
