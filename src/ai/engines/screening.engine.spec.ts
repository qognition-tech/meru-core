import { ScreeningEngine } from './screening.engine';
import type { WatchlistIngestService } from './watchlist-ingest.service';

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
  // The engine only reaches the ingest service when no customWatchlist is
  // supplied; every case here supplies one, so an empty stub is sufficient.
  const ingestStub = {
    loadAll: async () => [],
  } as unknown as WatchlistIngestService;

  const engine = new ScreeningEngine(ingestStub);

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
