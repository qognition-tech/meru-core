import {
  ScreeningEngine,
  ScreeningListsUnavailableException,
} from './screening.engine';
import type { WatchlistIngestService } from './watchlist-ingest.service';

/**
 * An ingest service whose table holds one row that cannot match anything the
 * suites below screen. The engine refuses to run against an empty table, so a
 * stub returning `[]` no longer yields results — it yields a 503, which is the
 * subject of the last describe block.
 */
const INERT_ROW = {
  listSource: 'ofac',
  externalId: 'inert-1',
  name: 'QXZV-7781 PLC',
  normalizedName: 'qxzv-7781 plc',
  aliases: [],
  entityType: 'organization',
  country: null,
  programs: [],
  remarks: null,
};
const ingestWithOneInertRow = () =>
  ({ loadAll: async () => [INERT_ROW] }) as unknown as WatchlistIngestService;

/**
 * Regression guard for the phonetic corroboration rule.
 *
 * A phonetic code match once scored a flat 0.85 — exactly the default
 * threshold — so any Double Metaphone collision became a hit. Against the real
 * OFAC list that made every invented name screen as `escalated`: "Jane
 * Quillingford Ordinary" matched "ZHANG, Lei" and "ANGLO-CARIBBEAN CO., LTD.".
 *
 * An engine that flags everyone is operationally identical to one that flags
 * no one — the alerts get turned off, and the real designation goes with them.
 * These tests exist so that regression is loud rather than silent, because
 * nothing else about the system would reveal it.
 */
describe('ScreeningEngine — phonetic matches must be corroborated', () => {
  const engine = new ScreeningEngine(ingestWithOneInertRow());

  const screen = (name: string, listNames: string[]) =>
    engine.screen({
      tenantId: '00000000-0000-4000-8000-000000000001',
      entityName: name,
      entityType: 'individual',
      screeningTypes: ['sanctions'],
      customWatchlist: listNames.map((n, i) => ({
        id: `test-${i}`,
        name: n,
        aliases: [],
        type: 'individual' as const,
        listSource: 'ofac' as const,
      })),
    });

  describe('does not flag unrelated names', () => {
    // Real collisions observed against OFAC once 20k rows were loaded. Each
    // pair shares a phonetic code and a prefix, and nothing else.
    it.each([
      ['Margarethe Vandersloot', 'MARGARITA 1'],
      ['Margarethe Vandersloot', 'MARGARITIS, Antonios'],
      ['Dmitri Kowalczyk Rutherford', 'DMITRIEV, Kirill Aleksandrovich'],
      ['Jane Quillingford Ordinary', 'ZHANG, Lei'],
      ['Bartholomew Fenwick-Strathmore', 'PORTILLA BARRAZA, Jorge'],
    ])('%s is clear against %s', async (name, listEntry) => {
      const result = await screen(name, [listEntry]);
      expect(result.hits).toHaveLength(0);
      expect(result.status).toBe('clear');
    });
  });

  describe('still catches the transliteration cases phonetics exist for', () => {
    it.each([
      ['Mohammed Ali', 'Muhammad Ali'],
      ['Mohamad Hassan', 'Muhammad Hasan'],
      ['Abdul Rahman', 'Abdulrahman'],
    ])('%s matches %s', async (name, listEntry) => {
      const result = await screen(name, [listEntry]);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.status).not.toBe('clear');
    });
  });

  it('still matches an exact designation', async () => {
    const result = await screen('ASGARI, Mohammad', ['ASGARI, Mohammad']);
    expect(result.hits[0].algorithm).toBe('exact');
    expect(result.hits[0].matchScore).toBe(1);
  });

  it('gates on Levenshtein, not Jaro-Winkler', () => {
    // The property the fix depends on: Jaro-Winkler cannot separate these two
    // groups because its prefix bonus rewards a shared forename, while
    // Levenshtein separates them with a wide margin. If this stops holding,
    // the corroboration floor is measuring the wrong thing.
    const falsePair = ['margarethe vandersloot', 'margarita 1'] as const;
    const truePair = ['mohammed ali', 'muhammad ali'] as const;

    expect(engine.jaroWinkler(...falsePair)).toBeGreaterThan(0.8);
    expect(engine.jaroWinkler(...truePair)).toBeGreaterThan(0.8);

    expect(engine.levenshteinRatio(...falsePair)).toBeLessThan(0.55);
    expect(engine.levenshteinRatio(...truePair)).toBeGreaterThan(0.75);
  });
});

/**
 * Regression guard for over-escalation.
 *
 * Measured against the 31,579 real list entries on production, invented
 * individual "Zephyrine Bloxwich" returned `riskLevel: "critical"`,
 * `riskScore: 75` and the recommendation "Immediate escalation required. Do not
 * proceed without MLRO sign-off. File SAR if applicable." — on the strength of
 * a single 0.86 Jaro-Winkler match against OFAC's **vessel** "ZEPHYR I".
 *
 * Two independent faults produced that. Any hit from a sanctions source floored
 * the score at 75, ignoring the `severity` band the engine had already
 * computed; and an `individual` query was compared against vessels and
 * companies, where Jaro-Winkler's prefix bonus rewards a short candidate
 * sharing a first syllable.
 *
 * Reporting noise as a designation is the mirror image of reporting a
 * designation as clear, and costs the same thing in the end: a compliance
 * officer who stops believing the output.
 */
describe('ScreeningEngine — a warning is not a designation', () => {
  const engine = new ScreeningEngine(ingestWithOneInertRow());

  const screenAgainst = (
    name: string,
    entries: Array<{
      name: string;
      type: 'individual' | 'organization' | 'vessel';
      aliases?: string[];
    }>,
    entityType: 'individual' | 'organization' | 'vessel' | 'transaction' = 'individual',
  ) =>
    engine.screen({
      tenantId: '00000000-0000-4000-8000-000000000001',
      entityName: name,
      entityType,
      screeningTypes: ['sanctions'],
      customWatchlist: entries.map((e, i) => ({
        id: `t-${i}`,
        name: e.name,
        aliases: e.aliases ?? [],
        type: e.type,
        listSource: 'ofac' as const,
      })),
    });

  it('does not compare a person against a vessel', async () => {
    const result = await screenAgainst('Zephyrine Bloxwich', [
      { name: 'ZEPHYR I', type: 'vessel' },
    ]);
    expect(result.hits).toHaveLength(0);
    expect(result.status).toBe('clear');
  });

  it('does not compare a person against a company', async () => {
    const result = await screenAgainst('Vladimir Kestrelton', [
      { name: 'VLADIMIR MONOMAKH', type: 'organization' },
    ]);
    expect(result.hits).toHaveLength(0);
  });

  it('screens a vessel against vessels', async () => {
    const result = await screenAgainst(
      'Zephyr I',
      [{ name: 'ZEPHYR I', type: 'vessel' }],
      'vessel',
    );
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('screens a transaction against every kind of entry', async () => {
    // A transaction's counterparty may be a person, a company or a ship, so
    // narrowing by type there would hide real exposure.
    const result = await screenAgainst(
      'Kim Jong Un',
      [{ name: 'KIM JONG UN', type: 'individual' }],
      'transaction',
    );
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('does not escalate or recommend a SAR on warnings alone', async () => {
    // Same-type now, so the comparison is legitimate — but still only a fuzzy
    // near-miss, and must not present as a confirmed designation. This pair sits
    // at jw 0.870 per the measurements on PHONETIC_CORROBORATION_FLOOR: above
    // the 0.85 reporting threshold, below the 0.95 confirmation band.
    const result = await screenAgainst('Mohammed Ali', [
      { name: 'Muhammad Ali', type: 'individual' },
    ]);

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.severity === 'warning')).toBe(true);
    expect(result.riskLevel).not.toBe('critical');
    expect(result.status).not.toBe('escalated');
    expect(result.recommendation).not.toMatch(/SAR/);
    // The finding must still be visible — the fix is honesty, not suppression.
    expect(result.status).toBe('review_required');
  });

  it('names warnings as unconfirmed even when enough of them add up', async () => {
    // Warnings still accumulate past the `critical` boundary arithmetically.
    // "We found six 0.87s" is grounds for a human to look, not grounds to
    // refuse a customer and file a report, so the ceiling is `high` and the
    // wording says which kind of finding it is.
    const result = await screenAgainst(
      'Mohammed Ali',
      // Each measured in the 0.85–0.95 warning band against this query.
      [
        { name: 'Muhammad Ali', type: 'individual' },
        { name: 'Muhammed Alim', type: 'individual' },
        { name: 'Mohamud Alii', type: 'individual' },
        { name: 'Muhammad Alia', type: 'individual' },
        { name: 'Mahmoud Alavi', type: 'individual' },
        { name: 'Muhammet Aliev', type: 'individual' },
        { name: 'Mohamed Alaoui', type: 'individual' },
        { name: 'Mohammad Alie', type: 'individual' },
      ],
    );

    expect(result.hits.every((h) => h.severity === 'warning')).toBe(true);
    expect(result.riskLevel).not.toBe('critical');
    expect(result.recommendation).not.toMatch(/SAR/);
    expect(result.recommendation).toMatch(/unconfirmed/i);
  });

  it('still escalates a confirmed designation', async () => {
    const result = await screenAgainst('Kim Jong Un', [
      { name: 'KIM JONG UN', type: 'individual' },
    ]);
    expect(result.riskLevel).toBe('critical');
    expect(result.status).toBe('escalated');
    expect(result.recommendation).toMatch(/SAR/);
  });

  it('confirms a designation written surname-first', async () => {
    // How every sanctions list actually stores names, and how no user types
    // them. Before token-set matching this arrived as a ~0.87 warning, so no
    // genuine designation ever reached the `alert` band at all.
    const result = await screenAgainst('Vladimir Putin', [
      { name: 'PUTIN, Vladimir', type: 'individual' },
    ]);
    expect(result.hits[0].severity).toBe('alert');
    expect(result.hits[0].matchScore).toBe(1);
    expect(result.status).toBe('escalated');
  });

  it('confirms a designation when the list carries an extra patronymic', async () => {
    const result = await screenAgainst('Vladimir Putin', [
      { name: 'PUTIN, Vladimir Vladimirovich', type: 'individual' },
    ]);
    expect(result.hits[0].severity).toBe('alert');
    expect(result.hits[0].algorithm).toBe('token_set');
    // Scored below a pure reordering: the strings were not identical.
    expect(result.hits[0].matchScore).toBeLessThan(1);
  });

  it('does not let a bare forename confirm itself', async () => {
    // "vladimir" is a token of thousands of entries. A single shared word is
    // not an identity claim.
    const result = await screenAgainst('Vladimir', [
      { name: 'PUTIN, Vladimir Vladimirovich', type: 'individual' },
    ]);
    expect(result.hits.some((h) => h.severity === 'alert')).toBe(false);
  });

  it('does not confirm a match on surname alone', async () => {
    const result = await screenAgainst('Jonathan Putin-Smythe', [
      { name: 'PUTIN, Vladimir', type: 'individual' },
    ]);
    expect(result.hits.some((h) => h.severity === 'alert')).toBe(false);
  });

  it('counts near-duplicate variants of one entry as one piece of evidence', async () => {
    // Twelve fuzzy spellings of the same listed person is one finding. Scoring
    // the undeduplicated hits let repetition alone reach 100.
    const result = await screenAgainst('Muhammad Hasan', [
      { name: 'Mohammed Hassan', type: 'individual', aliases: ['Mohamad Hasan', 'Muhammed Hassan'] },
    ]);
    expect(result.riskScore).toBeLessThan(100);
  });
});

/**
 * Regression guard for P0-2: screening returned "clean" for everyone.
 *
 * `watchlist_entries` was empty in production — the ingest had never run,
 * because `CronSecretGuard` fails closed without `CRON_SECRET` — and the engine
 * fell back to a dozen hardcoded samples. Every real counterparty screened
 * `clear`, and the result body was byte-for-byte the shape of a genuine no-hit.
 * Unknown is never clear (CLAUDE.md §5.2): with no list there is no screen.
 */
describe('ScreeningEngine — refuses to screen against nothing', () => {
  const request = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    entityName: 'Kim Jong Un',
    entityType: 'individual' as const,
    screeningTypes: ['sanctions' as const],
  };

  it('throws 503 with listsLoaded:false when watchlist_entries is empty', async () => {
    const engine = new ScreeningEngine(
      { loadAll: async () => [] } as unknown as WatchlistIngestService,
    );
    const err = await engine.screen(request).catch((e) => e);
    expect(err).toBeInstanceOf(ScreeningListsUnavailableException);
    expect(err.getStatus()).toBe(503);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.listsLoaded).toBe(false);
    expect(typeof body.unavailableReason).toBe('string');
    expect(body.unavailableReason).toContain('watchlist-ingest');
    // The one thing it must never be.
    expect(body.status).not.toBe('clear');
  });

  it('still refuses when the caller supplies a customWatchlist', async () => {
    // A custom list is in addition to the sanctions lists, not instead of
    // them. "Clear against your three names" is not a sanctions screen.
    const engine = new ScreeningEngine(
      { loadAll: async () => [] } as unknown as WatchlistIngestService,
    );
    await expect(
      engine.screen({
        ...request,
        customWatchlist: [
          { id: 'c1', name: 'Someone Else', type: 'individual', listSource: 'custom' },
        ],
      }),
    ).rejects.toBeInstanceOf(ScreeningListsUnavailableException);
  });

  it('throws 503 rather than "clear" when the lists cannot be read', async () => {
    const engine = new ScreeningEngine(
      {
        loadAll: async () => {
          throw new Error('connection refused');
        },
      } as unknown as WatchlistIngestService,
    );
    const err = await engine.screen(request).catch((e) => e);
    expect(err).toBeInstanceOf(ScreeningListsUnavailableException);
    expect((err.getResponse() as any).listsLoaded).toBe(false);
  });

  it('does not cache an empty table, so the first ingest takes effect immediately', async () => {
    let rows: unknown[] = [];
    const engine = new ScreeningEngine(
      { loadAll: async () => rows } as unknown as WatchlistIngestService,
    );
    await expect(engine.screen(request)).rejects.toBeInstanceOf(
      ScreeningListsUnavailableException,
    );
    rows = [INERT_ROW];
    const result = await engine.screen(request);
    expect(result.listsLoaded).toBe(true);
    expect(result.listEntries).toBe(1);
  });

  it('a returned result always states what it screened against', async () => {
    const engine = new ScreeningEngine(ingestWithOneInertRow());
    const result = await engine.screen(request);
    expect(result.listsLoaded).toBe(true);
    expect(result.listEntries).toBe(1);
    expect(result.status).toBe('clear');
  });
});
