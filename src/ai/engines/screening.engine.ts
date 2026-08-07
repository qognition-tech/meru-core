import { Injectable, Logger } from '@nestjs/common';
import { WatchlistIngestService } from './watchlist-ingest.service';
// Classical string metrics from `talisman` rather than hand-rolled copies.
// CommonJS on purpose (see scripts/check-cjs-deps.js); `require` because the
// package ships no bundled type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jaroWinklerSimilarity: (
  a: string,
  b: string,
) => number = require('talisman/metrics/jaro-winkler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const levenshteinDistance: (
  a: string,
  b: string,
) => number = require('talisman/metrics/levenshtein');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const soundexCode: (
  s: string,
) => string = require('talisman/phonetics/soundex');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const doubleMetaphoneCodes: (
  s: string,
) => [string, string] = require('talisman/phonetics/double-metaphone');
import * as crypto from 'crypto';

// ── Public types ──────────────────────────────────────────────────────────

export interface ScreeningRequest {
  tenantId: string;
  entityId?: string;
  entityName: string;
  entityType: 'individual' | 'organization' | 'vessel' | 'transaction';
  screeningTypes: ScreeningType[];
  metadata?: Record<string, any>;
  identities?: Array<{
    field: string;
    value: string;
    type:
      | 'name'
      | 'alias'
      | 'document'
      | 'address'
      | 'date_of_birth'
      | 'nationality';
  }>;
  // Allow caller to supply a custom watchlist for this request
  customWatchlist?: WatchlistEntry[];
}

export type ScreeningType =
  | 'sanctions'
  | 'pep'
  | 'adverse_media'
  | 'watchlist'
  | 'criminal'
  | 'financial'
  | 'identity_verification'
  | 'document_verification'
  | 'custom';

export interface ScreeningResult {
  screeningId: string;
  entityId?: string;
  status: 'clear' | 'hit' | 'review_required' | 'escalated' | 'error';
  riskScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  hits: ScreeningHit[];
  summary: string;
  recommendation?: string;
  completedAt: Date;
  durationMs: number;
}

export interface ScreeningHit {
  type: ScreeningType;
  source: string;
  matchName: string;
  matchScore: number; // 0-1
  algorithm:
    | 'exact'
    | 'levenshtein'
    | 'double_metaphone'
    | 'jaro_winkler'
    | 'soundex'
    | 'transliteration';
  details: string;
  severity: 'info' | 'warning' | 'alert';
  listEntry?: WatchlistEntry;
  timestamp: Date;
}

export interface WatchlistEntry {
  id: string;
  name: string;
  aliases?: string[];
  type: 'individual' | 'organization' | 'vessel';
  listSource: 'ofac' | 'eu' | 'un' | 'uk_hmt' | 'uae_local' | 'custom';
  country?: string;
  dateOfBirth?: string;
  identifiers?: Array<{ type: string; value: string }>;
  programs?: string[];
  remarks?: string;
}

// ── Watchlist registry ────────────────────────────────────────────────────

// Built-in lists are minimal structural examples for deterministic testing.
// In production these are replaced by live-feed adapters in the INT module.
const BUILTIN_WATCHLISTS: WatchlistEntry[] = [
  // OFAC SDN samples
  {
    id: 'ofac-001',
    name: 'Al-Shabaab',
    aliases: ['Al Shabaab', 'Harakat al-Shabaab'],
    type: 'organization',
    listSource: 'ofac',
    country: 'SO',
    programs: ['SDGT'],
  },
  {
    id: 'ofac-002',
    name: 'Hezbollah',
    aliases: ['Hizballah', 'Hizbullah', 'Party of God'],
    type: 'organization',
    listSource: 'ofac',
    country: 'LB',
    programs: ['SDGT', 'LEBANON'],
  },
  {
    id: 'ofac-003',
    name: 'Kim Jong Un',
    aliases: ['Kim Jong-un', 'Kim Jongun'],
    type: 'individual',
    listSource: 'ofac',
    country: 'KP',
    dateOfBirth: '1984-01-08',
    programs: ['DPRK3'],
  },
  // UN samples
  {
    id: 'un-001',
    name: 'Islamic State',
    aliases: ['ISIS', 'ISIL', 'Daesh', "Da'esh"],
    type: 'organization',
    listSource: 'un',
    programs: ['1267'],
  },
  {
    id: 'un-002',
    name: 'Al-Qaida',
    aliases: ['Al Qaeda', 'Al-Qaeda', 'AQ'],
    type: 'organization',
    listSource: 'un',
    programs: ['1267'],
  },
  // UAE local samples
  {
    id: 'uae-001',
    name: 'Muslim Brotherhood',
    aliases: ['Al-Ikhwan al-Muslimun', 'Ikhwan'],
    type: 'organization',
    listSource: 'uae_local',
    programs: ['UAE_TERROR'],
  },
];

// ── ScreeningEngine ───────────────────────────────────────────────────────

@Injectable()
export class ScreeningEngine {
  private readonly logger = new Logger(ScreeningEngine.name);

  // Sub-200ms p95 target: all matching is in-process (no network I/O per name).
  // Ingested lists are therefore cached in memory and refreshed on a TTL —
  // reloading ~17k OFAC rows per screening request would miss that budget by
  // orders of magnitude.
  private cache: { entries: WatchlistEntry[]; expires: number } | null = null;
  private static readonly CACHE_TTL_MS = 10 * 60_000;

  constructor(private readonly watchlistIngest: WatchlistIngestService) {}

  /**
   * The lists to screen against.
   *
   * Ingested rows (OFAC SDN, UN Consolidated) are authoritative when present.
   * BUILTIN_WATCHLISTS remains only as the fallback for a database that has
   * never been ingested into — without it a fresh install would silently
   * clear every name, which is the most dangerous possible failure mode for
   * a sanctions screen.
   */
  private async loadWatchlist(): Promise<WatchlistEntry[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.entries;

    let entries: WatchlistEntry[] = BUILTIN_WATCHLISTS;
    try {
      const rows = await this.watchlistIngest.loadAll();
      if (rows.length > 0) {
        entries = rows.map((r) => ({
          id: `${r.listSource}-${r.externalId}`,
          name: r.name,
          aliases: r.aliases ?? [],
          type: (r.entityType === 'individual'
            ? 'individual'
            : 'organization') as WatchlistEntry['type'],
          listSource: r.listSource as WatchlistEntry['listSource'],
          country: r.country ?? undefined,
          programs: r.programs ?? [],
          remarks: r.remarks ?? undefined,
        }));
      } else {
        this.logger.warn(
          'watchlist_entries is empty — screening against built-in samples only. ' +
            'Run the watchlist-ingest job to load OFAC/UN.',
        );
      }
    } catch (err) {
      // Screening must not fail closed into "no hits": that reports a
      // sanctioned party as clear. Fall back loudly instead.
      this.logger.error(
        `Watchlist load failed, falling back to built-in samples: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.cache = {
      entries,
      expires: Date.now() + ScreeningEngine.CACHE_TTL_MS,
    };
    return entries;
  }

  /** Drops the cache so a fresh ingest takes effect immediately. */
  invalidateCache(): void {
    this.cache = null;
  }

  async screen(
    request: ScreeningRequest,
    threshold = 0.85,
  ): Promise<ScreeningResult> {
    const startMs = Date.now();
    const screeningId = `scr_${crypto.randomUUID()}`;
    const hits: ScreeningHit[] = [];

    const namesToCheck = this.buildNameList(request);
    const watchlist = [
      ...(await this.loadWatchlist()),
      ...(request.customWatchlist ?? []),
    ].filter((entry) => this.listMatchesTypes(entry, request.screeningTypes));

    for (const name of namesToCheck) {
      for (const entry of watchlist) {
        const bestMatch = this.matchAgainstEntry(name, entry, threshold);
        if (bestMatch)
          hits.push({
            ...bestMatch,
            type: this.entryToScreeningType(entry),
            timestamp: new Date(),
          });
      }
    }

    const { riskScore, riskLevel, status } = this.computeRisk(hits, request);

    return {
      screeningId,
      entityId: request.entityId,
      status,
      riskScore,
      riskLevel,
      hits: this.deduplicateHits(hits),
      summary: this.buildSummary(hits, riskLevel),
      recommendation: this.buildRecommendation(riskLevel, hits),
      completedAt: new Date(),
      durationMs: Date.now() - startMs,
    };
  }

  // ── Name list builder ────────────────────────────────────────────────────

  private buildNameList(request: ScreeningRequest): string[] {
    const names = new Set<string>();
    names.add(this.normalise(request.entityName));

    if (request.identities) {
      for (const id of request.identities) {
        if (id.type === 'name' || id.type === 'alias') {
          names.add(this.normalise(id.value));
        }
      }
    }

    return Array.from(names).filter(Boolean);
  }

  // ── Matching against a single watchlist entry ────────────────────────────

  private matchAgainstEntry(
    name: string,
    entry: WatchlistEntry,
    threshold: number,
  ): Omit<ScreeningHit, 'type' | 'timestamp'> | null {
    const candidates = [entry.name, ...(entry.aliases ?? [])].map((c) =>
      this.normalise(c),
    );

    let best: {
      score: number;
      algorithm: ScreeningHit['algorithm'];
      candidate: string;
    } | null = null;

    for (const candidate of candidates) {
      // 1. Exact
      if (name === candidate) {
        return {
          source: entry.listSource.toUpperCase(),
          matchName: entry.name,
          matchScore: 1.0,
          algorithm: 'exact',
          details: `Exact match against ${entry.listSource.toUpperCase()} entry "${entry.name}"`,
          severity: 'alert',
          listEntry: entry,
        };
      }

      // 2. Jaro-Winkler (best for names — prefix-sensitive)
      const jw = this.jaroWinkler(name, candidate);
      if (jw > (best?.score ?? 0))
        best = { score: jw, algorithm: 'jaro_winkler', candidate };

      // 3. Levenshtein ratio (good for OCR errors, typos)
      const lev = this.levenshteinRatio(name, candidate);
      if (lev > (best?.score ?? 0))
        best = { score: lev, algorithm: 'levenshtein', candidate };

      // 4. Phonetic. Double Metaphone first — it encodes an alternate
      // pronunciation, so Mohammed / Muhammad / Mohamad all reduce to MHMT,
      // which is the single most common family of near-misses on sanctions
      // lists. Soundex is kept as a weaker fallback: it is English-tuned and
      // four characters wide, so it agrees less often and is worth less when
      // it does.
      if (name.length > 2) {
        if (this.phoneticallyEqual(name, candidate)) {
          const score = 0.85;
          if (score > (best?.score ?? 0))
            best = { score, algorithm: 'double_metaphone', candidate };
        } else if (this.soundex(name) === this.soundex(candidate)) {
          const score = 0.8; // below exact but above random
          if (score > (best?.score ?? 0))
            best = { score, algorithm: 'soundex', candidate };
        }
      }

      // 5. Transliteration — Arabic/Latin normalisation
      const translitName = this.transliterateArabic(name);
      const translitCandidate = this.transliterateArabic(candidate);
      if (translitName !== name || translitCandidate !== candidate) {
        const tJw = this.jaroWinkler(translitName, translitCandidate);
        if (tJw > (best?.score ?? 0))
          best = { score: tJw, algorithm: 'transliteration', candidate };
      }
    }

    if (!best || best.score < threshold) return null;

    return {
      source: entry.listSource.toUpperCase(),
      matchName: entry.name,
      matchScore: best.score,
      algorithm: best.algorithm,
      details: `${best.algorithm} match (${(best.score * 100).toFixed(1)}%) against ${entry.listSource.toUpperCase()} entry "${entry.name}"`,
      severity: best.score >= 0.95 ? 'alert' : 'warning',
      listEntry: entry,
    };
  }

  // ── Fuzzy algorithms ──────────────────────────────────────────────────────
  //
  // These delegate to `talisman`, a maintained open-source implementation of
  // the classical string metrics. They used to be hand-written here — roughly
  // 120 lines of Jaro, Jaro-Winkler, Levenshtein and Soundex. Sanctions
  // screening is exactly the wrong place to carry a bespoke edit-distance
  // implementation: a subtle error in the match window or the prefix bonus
  // does not crash, it silently fails to flag a sanctioned party, and nothing
  // in the system would tell you. A widely used library is the safer default.
  //
  // `talisman` is CommonJS, which matters — see scripts/check-cjs-deps.js and
  // the otplib note in iam.service.ts.

  /** Jaro-Winkler similarity in [0, 1]. Strong on proper names. */
  jaroWinkler(s1: string, s2: string): number {
    if (!s1 || !s2) return 0;
    return jaroWinklerSimilarity(s1, s2);
  }

  /** Normalised Levenshtein similarity in [0, 1]. Good for OCR noise/typos. */
  levenshteinRatio(s1: string, s2: string): number {
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(s1, s2) / maxLen;
  }

  levenshtein(s1: string, s2: string): number {
    return levenshteinDistance(s1, s2);
  }

  /** Soundex phonetic code. Retained for the `soundex` algorithm label. */
  soundex(name: string): string {
    const cleaned = name.toUpperCase().replace(/[^A-Z]/g, '');
    if (!cleaned) return '0000';
    return soundexCode(cleaned);
  }

  /**
   * Double Metaphone — two codes per name, a primary and an alternate.
   *
   * Materially better than Soundex for this domain. Soundex is tuned for
   * English surnames and keeps only four characters, so it both misses
   * transliteration variants and generates noise on Arabic names. Double
   * Metaphone encodes a plausible alternate pronunciation, which is precisely
   * the Mohammed/Muhammad/Mohamad problem sanctions lists are full of — all
   * three share the code MHMT.
   */
  doubleMetaphone(name: string): [string, string] {
    const cleaned = name.toUpperCase().replace(/[^A-Z]/g, '');
    if (!cleaned) return ['', ''];
    const [primary, alternate] = doubleMetaphoneCodes(cleaned);
    return [primary, alternate];
  }

  /** True when two names share either metaphone code. */
  private phoneticallyEqual(a: string, b: string): boolean {
    const [aP, aS] = this.doubleMetaphone(a);
    const [bP, bS] = this.doubleMetaphone(b);
    if (!aP || !bP) return false;
    return aP === bP || aP === bS || aS === bP || (!!aS && aS === bS);
  }

  // Arabic → Latin transliteration (common variants).
  // Covers the most frequent mis-transliterations seen in sanctions lists.
  private transliterateArabic(text: string): string {
    return text
      .replace(/[آأإا]/g, 'a')
      .replace(/ب/g, 'b')
      .replace(/[تث]/g, 't')
      .replace(/[جچ]/g, 'j')
      .replace(/[حخ]/g, 'h')
      .replace(/د/g, 'd')
      .replace(/ذ/g, 'z')
      .replace(/ر/g, 'r')
      .replace(/ز/g, 'z')
      .replace(/س/g, 's')
      .replace(/ش/g, 'sh')
      .replace(/ص/g, 's')
      .replace(/ض/g, 'd')
      .replace(/ط/g, 't')
      .replace(/ظ/g, 'z')
      .replace(/ع/g, '')
      .replace(/غ/g, 'gh')
      .replace(/ف/g, 'f')
      .replace(/ق/g, 'q')
      .replace(/ك/g, 'k')
      .replace(/ل/g, 'l')
      .replace(/م/g, 'm')
      .replace(/ن/g, 'n')
      .replace(/ه/g, 'h')
      .replace(/[وؤ]/g, 'w')
      .replace(/[يئى]/g, 'y')
      .replace(/ة/g, 'a');
  }

  // ── Normalisation ─────────────────────────────────────────────────────────

  normalise(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s؀-ۿ]/g, '') // keep Latin, digits, spaces, Arabic
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Risk scoring ──────────────────────────────────────────────────────────

  private computeRisk(
    hits: ScreeningHit[],
    _request: ScreeningRequest,
  ): {
    riskScore: number;
    riskLevel: ScreeningResult['riskLevel'];
    status: ScreeningResult['status'];
  } {
    if (hits.length === 0)
      return { riskScore: 0, riskLevel: 'low', status: 'clear' };

    const alertHits = hits.filter((h) => h.severity === 'alert');
    const warnHits = hits.filter((h) => h.severity === 'warning');

    let riskScore = 0;
    riskScore += alertHits.length * 40;
    riskScore += warnHits.length * 15;
    riskScore = Math.min(100, riskScore);

    // Boost score for sanctions list hits (OFAC, UN, EU)
    const sanctionHits = hits.filter((h) =>
      ['OFAC', 'UN', 'EU', 'UK_HMT', 'UAE_LOCAL'].includes(h.source),
    );
    if (sanctionHits.length > 0) riskScore = Math.max(riskScore, 75);

    let riskLevel: ScreeningResult['riskLevel'];
    let status: ScreeningResult['status'];

    if (riskScore >= 75) {
      riskLevel = 'critical';
      status = 'escalated';
    } else if (riskScore >= 50) {
      riskLevel = 'high';
      status = 'hit';
    } else if (riskScore >= 25) {
      riskLevel = 'medium';
      status = 'review_required';
    } else {
      riskLevel = 'low';
      status = 'review_required';
    }

    return { riskScore, riskLevel, status };
  }

  private deduplicateHits(hits: ScreeningHit[]): ScreeningHit[] {
    const seen = new Set<string>();
    return hits.filter((h) => {
      const key = `${h.source}:${h.matchName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private buildSummary(hits: ScreeningHit[], riskLevel: string): string {
    if (hits.length === 0)
      return 'No matches found across configured watchlists.';
    const alerts = hits.filter((h) => h.severity === 'alert').length;
    const warnings = hits.filter((h) => h.severity === 'warning').length;
    return `${hits.length} match(es) found — ${alerts} alert(s), ${warnings} warning(s). Risk level: ${riskLevel.toUpperCase()}.`;
  }

  private buildRecommendation(riskLevel: string, hits: ScreeningHit[]): string {
    switch (riskLevel) {
      case 'critical':
        return 'Immediate escalation required. Do not proceed without MLRO sign-off. File SAR if applicable.';
      case 'high':
        return 'Refer to compliance officer for Enhanced Due Diligence (EDD). Do not onboard until cleared.';
      case 'medium':
        return 'Flag for analyst review. Obtain additional identity documentation before proceeding.';
      default:
        return hits.length > 0
          ? 'Low confidence matches noted. Proceed with standard verification.'
          : 'No action required. Proceed normally.';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private listMatchesTypes(
    entry: WatchlistEntry,
    types: ScreeningType[],
  ): boolean {
    if (
      types.includes('sanctions') &&
      ['ofac', 'eu', 'un', 'uk_hmt', 'uae_local'].includes(entry.listSource)
    )
      return true;
    if (types.includes('watchlist') && entry.listSource === 'custom')
      return true;
    if (types.includes('pep') && entry.listSource === 'custom') return true;
    return types.some((t) => t === (entry.listSource as string));
  }

  private entryToScreeningType(entry: WatchlistEntry): ScreeningType {
    if (['ofac', 'eu', 'un', 'uk_hmt', 'uae_local'].includes(entry.listSource))
      return 'sanctions';
    if (entry.listSource === 'custom') return 'watchlist';
    return 'watchlist';
  }
}
