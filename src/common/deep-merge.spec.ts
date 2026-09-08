import { deepMerge } from './deep-merge';

/**
 * The bug this exists to prevent: a PATCH that deletes data the caller never
 * mentioned.
 *
 * `verticalAttributes` was spread one level deep, which looked like a merge and
 * was not. The immigration pack keeps a lead's identity under `lead.fields`, so
 * `{ lead: { lead_status: 'converted' } }` replaced the whole `lead` object and
 * erased the person's name — silently, during lead conversion, in production.
 */
describe('deepMerge', () => {
  it('keeps nested siblings the patch did not mention', () => {
    const before = {
      lead: { fields: { first_name: 'Conv', last_name: 'Test' }, lead_status: 'new' },
    };
    const after = deepMerge(before, { lead: { lead_status: 'converted' } });

    expect(after.lead.lead_status).toBe('converted');
    // The exact assertion that failed against production.
    expect(after.lead.fields).toEqual({ first_name: 'Conv', last_name: 'Test' });
  });

  it('merges siblings at the top level too', () => {
    const after = deepMerge({ a: 1, b: 2 }, { b: 3 });
    expect(after).toEqual({ a: 1, b: 3 });
  });

  it('merges arbitrarily deep', () => {
    const after = deepMerge(
      { one: { two: { three: { keep: 'yes', change: 'no' } } } },
      { one: { two: { three: { change: 'yes' } } } },
    );
    expect(after.one.two.three).toEqual({ keep: 'yes', change: 'yes' });
  });

  it('replaces arrays rather than merging by index', () => {
    // Merging positionally would leave ['a', 'y'], which no caller expects.
    const after = deepMerge({ tags: ['x', 'y'] }, { tags: ['a'] });
    expect(after.tags).toEqual(['a']);
  });

  it('deletes a key when the patch sends null', () => {
    // The only way to clear an attribute. Without it every write is additive
    // and a mistyped key is permanent.
    const after = deepMerge({ a: 1, b: 2 }, { b: null });
    expect(after).toEqual({ a: 1 });
    expect('b' in after).toBe(false);
  });

  it('ignores undefined so absent keys are not deletions', () => {
    const after = deepMerge({ a: 1, b: 2 }, { b: undefined });
    expect(after).toEqual({ a: 1, b: 2 });
  });

  it('replaces a Date instead of merging its internals', () => {
    const next = new Date('2026-08-11T00:00:00Z');
    const after = deepMerge({ at: new Date('2020-01-01T00:00:00Z') }, { at: next });
    expect(after.at).toBe(next);
  });

  it('replaces a plain object over a scalar and vice versa', () => {
    expect(deepMerge({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(deepMerge({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate either input', () => {
    const base = { a: { b: 1 } };
    const patch = { a: { c: 2 } };
    const after = deepMerge(base, patch);

    expect(base).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { c: 2 } });
    expect(after.a).toEqual({ b: 1, c: 2 });
  });

  it('does not let a patch key reach Object.prototype', () => {
    // `__proto__` arrives as an own enumerable key from JSON.parse, so it is
    // reachable from a request body. Assigning it must not pollute every object
    // in the process.
    const after = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // And the result's own prototype is untouched — assigning `__proto__` would
    // have swapped it rather than storing an attribute.
    expect(Object.getPrototypeOf(after)).toBe(Object.prototype);
    expect(after).toEqual({});
  });

  it('ignores constructor and prototype keys for the same reason', () => {
    const after = deepMerge({ keep: 1 }, {
      constructor: 'nope',
      prototype: 'nope',
    } as Record<string, unknown>);
    expect(after).toEqual({ keep: 1 });
    expect(typeof after.constructor).toBe('function');
  });
});
