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

/**
 * Two faults that turned the alert engine into a false-alarm generator, found
 * while authoring the first country-specific `alertRules`.
 *
 * A rule reading `matter.visaExpiry_daysUntil` resolved to undefined, because
 * flattening stopped at the top level of `verticalAttributes` and the packs — and
 * the frontend — nest everything under `matter`. On its own that would have made
 * the rule silent. But JsonLogic is total over missing data and JavaScript says
 * `null < 90`, so "expires within 90 days" was **true for every record**.
 *
 * Silent would have been a missing feature. Firing on everything is the failure
 * CLAUDE.md §5.2 warns about from the other side: an engine that flags the whole
 * tenant gets switched off, and the real deadline goes with it.
 */
describe('RuleEvaluatorService — a missing date must not satisfy a comparison', () => {
  const service = new RuleEvaluatorService();
  const iso = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  const record = (matter: Record<string, unknown>) => ({
    type: 'case',
    status: 'open',
    verticalAttributes: { matter },
  });

  const expiringWithin = (field: string, days: number) => ({
    and: [
      { '<': [{ var: `${field}_daysUntil` }, days] },
      { '>=': [{ var: `${field}_daysUntil` }, 0] },
    ],
  });

  it('derives _daysUntil for a date nested one level down', () => {
    const context = service.augment(record({ visaExpiry: iso(45) }));
    const matter = context.matter as Record<string, unknown>;
    expect(matter.visaExpiry_daysUntil).toBe(45);
    expect(matter.visaExpiry_daysSince).toBe(-45);
  });

  it('puts them inside the object, because `var` treats dots as a path', () => {
    // A flat key literally named `matter.visaExpiry_daysUntil` is unreachable:
    // JsonLogic walks `matter` then `visaExpiry_daysUntil`.
    const context = service.augment(record({ visaExpiry: iso(45) }));
    expect(context['matter.visaExpiry_daysUntil']).toBeUndefined();
    expect(
      service.matches(expiringWithin('matter.visaExpiry', 90), record({ visaExpiry: iso(45) })),
    ).toBe(true);
  });

  it('does not mutate the record it was given', () => {
    // `verticalAttributes.matter` is the entity's own object; writing derived
    // fields into it would persist them on the next save.
    const data = record({ visaExpiry: iso(45) });
    service.augment(data);
    expect(
      Object.keys((data.verticalAttributes as any).matter),
    ).toEqual(['visaExpiry']);
  });

  it('does not fire when the date is absent', () => {
    // The bug. Before the guard this returned true for every record.
    expect(
      service.matches(expiringWithin('matter.visaExpiry', 90), record({ subclass: '485' })),
    ).toBe(false);
  });

  it('does not fire on a greater-than against an absent date either', () => {
    expect(
      service.matches(
        { '>': [{ var: 'matter.medicalExam_daysSince' }, 305] },
        record({ subclass: '485' }),
      ),
    ).toBe(false);
  });

  it('still fires when the date is present and inside the window', () => {
    expect(
      service.matches(expiringWithin('matter.visaExpiry', 90), record({ visaExpiry: iso(30) })),
    ).toBe(true);
  });

  it('does not fire when the date is present and outside the window', () => {
    expect(
      service.matches(expiringWithin('matter.visaExpiry', 90), record({ visaExpiry: iso(200) })),
    ).toBe(false);
  });

  it('leaves absence meaningful to negation, which is what rules rely on', () => {
    // "the certificate has not been received" must still work — the guard covers
    // numeric comparisons only.
    expect(
      service.matches(
        { '!': [{ var: 'matter.atasCertificateReceived' }] },
        record({ atasRequired: true }),
      ),
    ).toBe(true);
  });

  it('respects an author-supplied default', () => {
    // `{"var": ["x", 0]}` handles its own absence, so it is not a hazard.
    expect(
      service.matches(
        { '<': [{ var: ['matter.nope_daysUntil', 5] }, 90] },
        record({ subclass: '485' }),
      ),
    ).toBe(true);
  });

  it('guards a comparison nested inside and/or', () => {
    expect(
      service.matches(
        {
          and: [
            { '==': [{ var: 'matter.subclass' }, '485'] },
            { '<': [{ var: 'matter.visaExpiry_daysUntil' }, 90] },
          ],
        },
        record({ subclass: '485' }),
      ),
    ).toBe(false);
  });

  it('still derives top-level attributes as before', () => {
    const context = service.augment({
      type: 'case',
      verticalAttributes: { visaExpiry: iso(10) },
    });
    expect(context.visaExpiry_daysUntil).toBe(10);
  });
});
