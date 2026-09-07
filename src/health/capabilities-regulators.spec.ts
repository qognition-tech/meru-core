import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REGULATOR_CREDENTIALS } from './capabilities.service';

/**
 * The capability report must name the credentials the adapters actually read.
 *
 * This is a source-parsing test, like `config-pack-loader.service.spec.ts`,
 * because the failure it guards is not reachable from behaviour: with no
 * credentials set every adapter is `unconfigured` either way, so a wrong
 * variable name produces an identical report and no test goes red. It only
 * surfaces the day someone sets `UKVI_CLIENT_ID` and the report keeps saying
 * `unconfigured`, or — worse — sets `AU_HOMEAFFAIRS_CLIENT_ID` alone and the
 * report says `live` while the adapter is still sandboxed.
 *
 * A comment asking for the same discipline was already there, and seven of the
 * eight rows had drifted anyway.
 */
describe('capability report — regulator credentials match their adapters', () => {
  const adapterDir = join(__dirname, '..', 'integrations', 'adapters');

  /** The env vars inside the adapter's own `credentialsPresent` expression. */
  const credentialsRead = (adapter: string): string[] => {
    const file = join(adapterDir, `${adapter}.adapter.ts`);
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf8');

    const start = src.indexOf('const credentialsPresent');
    expect(start).toBeGreaterThan(-1);
    // The predicate ends at the first `;` — every adapter writes it as a single
    // boolean expression assigned in one statement.
    const expr = src.slice(start, src.indexOf(';', start));

    return [...expr.matchAll(/configService\.get\(\s*'([A-Z0-9_]+)'/g)]
      .map((m) => m[1])
      .sort();
  };

  it.each(REGULATOR_CREDENTIALS.map((r) => [r.code, r.adapter, r.requires]))(
    '%s reports on exactly what %s reads',
    (_code, adapter, requires) => {
      expect(credentialsRead(adapter as string)).toEqual(
        [...(requires as string[])].sort(),
      );
    },
  );

  it('covers all eight adapters, so a ninth cannot be added unreported', () => {
    expect(REGULATOR_CREDENTIALS).toHaveLength(8);
    expect(new Set(REGULATOR_CREDENTIALS.map((r) => r.adapter)).size).toBe(8);
  });

  it('requires both halves of every credential pair', () => {
    for (const r of REGULATOR_CREDENTIALS) {
      if (r.requires.some((v) => v.endsWith('_CLIENT_ID'))) {
        expect(r.requires.some((v) => v.endsWith('_CLIENT_SECRET'))).toBe(true);
      }
    }
  });
});
