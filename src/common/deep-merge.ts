/** Keys that manipulate the prototype chain rather than naming an attribute. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Recursively merge `patch` into `base`, returning a new object.
 *
 * Written for `verticalAttributes` on a PATCH, where the caller sends only what
 * changed and everything else must survive. A top-level spread looked like it
 * did that and did not: packs nest, so `{ lead: { lead_status: 'converted' } }`
 * replaced the entire `lead` object and took `lead.fields.first_name` with it.
 *
 * The rules, and why each one is the way round it is:
 *
 * - **Plain objects merge.** That is the whole point.
 * - **Arrays replace.** Merging by index gives a result the caller cannot
 *   predict and never wants: sending `['a']` over `['x','y']` would leave
 *   `['a','y']`. A list is a value.
 * - **`null` deletes the key.** Without it there would be no way to clear an
 *   attribute at all — every write would be additive and a mistake permanent.
 *   `undefined` is ignored instead, so a serialised object with absent keys
 *   behaves like the partial update it is.
 * - **Class instances and dates replace.** Only plain objects are traversed; a
 *   `Date` or a `Buffer` is a value, and half-merging one produces something
 *   that is neither.
 */
export function deepMerge<T extends Record<string, any>>(
  base: T,
  patch: Record<string, any>,
): T {
  const out: Record<string, any> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    // `patch` is a request body — `verticalAttributes` arrives from a client —
    // and `JSON.parse` yields `__proto__` as an ordinary own key. Assigning it
    // would swap the result's prototype instead of storing an attribute, and
    // `constructor`/`prototype` are the same class of trick. Skipped rather
    // than rejected: these are never legitimate pack attribute names, so there
    // is nothing for a caller to correct.
    if (FORBIDDEN_KEYS.has(key)) continue;

    if (value === undefined) continue;

    if (value === null) {
      delete out[key];
      continue;
    }

    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, any>, value);
      continue;
    }

    out[key] = value;
  }

  return out as T;
}

/**
 * A `{}` literal or `Object.create(null)` — not an array, not a Date, not a
 * class instance. Deliberately strict: anything else is treated as a value, so
 * merging cannot produce a half-built object of a type that has invariants.
 */
function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
