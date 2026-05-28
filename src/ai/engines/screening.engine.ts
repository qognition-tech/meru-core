import { Injectable, Logger } from '@nestjs/common';
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
    type: 'name' | 'alias' | 'document' | 'address' | 'date_of_birth' | 'nationality';
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
  algorithm: 'exact' | 'levenshtein' | 'jaro_winkler' | 'soundex' | 'transliteration';
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
  { id: 'ofac-001', name: 'Al-Shabaab', aliases: ['Al Shabaab', 'Harakat al-Shabaab'], type: 'organization', listSource: 'ofac', country: 'SO', programs: ['SDGT'] },
  { id: 'ofac-002', name: 'Hezbollah', aliases: ['Hizballah', 'Hizbullah', 'Party of God'], type: 'organization', listSource: 'ofac', country: 'LB', programs: ['SDGT', 'LEBANON'] },
  { id: 'ofac-003', name: 'Kim Jong Un', aliases: ['Kim Jong-un', 'Kim Jongun'], type: 'individual', listSource: 'ofac', country: 'KP', dateOfBirth: '1984-01-08', programs: ['DPRK3'] },
  // UN samples
  { id: 'un-001', name: 'Islamic State', aliases: ['ISIS', 'ISIL', 'Daesh', 'Da\'esh'], type: 'organization', listSource: 'un', programs: ['1267'] },
  { id: 'un-002', name: 'Al-Qaida', aliases: ['Al Qaeda', 'Al-Qaeda', 'AQ'], type: 'organization', listSource: 'un', programs: ['1267'] },
  // UAE local samples
  { id: 'uae-001', name: 'Muslim Brotherhood', aliases: ['Al-Ikhwan al-Muslimun', 'Ikhwan'], type: 'organization', listSource: 'uae_local', programs: ['UAE_TERROR'] },
];

// ── ScreeningEngine ───────────────────────────────────────────────────────

@Injectable()
export class ScreeningEngine {
  private readonly logger = new Logger(ScreeningEngine.name);

  // Sub-200ms p95 target: all matching is in-process (no network I/O per name).
  // Live list ingestion happens asynchronously via the INT module.

  async screen(request: ScreeningRequest, threshold = 0.85): Promise<ScreeningResult> {
    const startMs = Date.now();
    const screeningId = `scr_${crypto.randomUUID()}`;
    const hits: ScreeningHit[] = [];

    const namesToCheck = this.buildNameList(request);
    const watchlist = [
      ...BUILTIN_WATCHLISTS,
      ...(request.customWatchlist ?? []),
    ].filter((entry) => this.listMatchesTypes(entry, request.screeningTypes));

    for (const name of namesToCheck) {
      for (const entry of watchlist) {
        const bestMatch = this.matchAgainstEntry(name, entry, threshold);
        if (bestMatch) hits.push({ ...bestMatch, type: this.entryToScreeningType(entry), timestamp: new Date() });
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
    const candidates = [
      entry.name,
      ...(entry.aliases ?? []),
    ].map((c) => this.normalise(c));

    let best: { score: number; algorithm: ScreeningHit['algorithm']; candidate: string } | null = null;

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
      if (jw > (best?.score ?? 0)) best = { score: jw, algorithm: 'jaro_winkler', candidate };

      // 3. Levenshtein ratio (good for OCR errors, typos)
      const lev = this.levenshteinRatio(name, candidate);
      if (lev > (best?.score ?? 0)) best = { score: lev, algorithm: 'levenshtein', candidate };

      // 4. Soundex (catches phonetic variations)
      if (this.soundex(name) === this.soundex(candidate) && name.length > 2) {
        const soundexScore = 0.80; // below exact but above random
        if (soundexScore > (best?.score ?? 0)) best = { score: soundexScore, algorithm: 'soundex', candidate };
      }

      // 5. Transliteration — Arabic/Latin normalisation
      const translitName = this.transliterateArabic(name);
      const translitCandidate = this.transliterateArabic(candidate);
      if (translitName !== name || translitCandidate !== candidate) {
        const tJw = this.jaroWinkler(translitName, translitCandidate);
        if (tJw > (best?.score ?? 0)) best = { score: tJw, algorithm: 'transliteration', candidate };
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

  // Jaro-Winkler: state-of-the-art for proper name matching.
  // Higher weight for common prefixes (first names).
  jaroWinkler(s1: string, s2: string): number {
    const jaro = this.jaro(s1, s2);
    const prefix = this.commonPrefixLength(s1, s2, 4);
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  private jaro(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (!s1.length || !s2.length) return 0;

    const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
    if (matchWindow < 0) return 0;

    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);
    let matches = 0;
    let transpositions = 0;

    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);
      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (!matches) return 0;

    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    return (
      (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3
    );
  }

  private commonPrefixLength(s1: string, s2: string, max: number): number {
    let i = 0;
    while (i < Math.min(s1.length, s2.length, max) && s1[i] === s2[i]) i++;
    return i;
  }

  // Levenshtein ratio: normalised edit distance [0, 1].
  levenshteinRatio(s1: string, s2: string): number {
    const dist = this.levenshtein(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);
    return maxLen === 0 ? 1 : 1 - dist / maxLen;
  }

  levenshtein(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          s1[i - 1] === s2[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  // Soundex phonetic encoding (English).
  soundex(name: string): string {
    const s = name.toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return '0000';

    const codes: Record<string, string> = {
      B: '1', F: '1', P: '1', V: '1',
      C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
      D: '3', T: '3',
      L: '4',
      M: '5', N: '5',
      R: '6',
    };

    let code = s[0];
    let prev = codes[s[0]] ?? '0';

    for (let i = 1; i < s.length && code.length < 4; i++) {
      const c = codes[s[i]] ?? '0';
      if (c !== '0' && c !== prev) code += c;
      prev = c;
    }

    return code.padEnd(4, '0');
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
  ): { riskScore: number; riskLevel: ScreeningResult['riskLevel']; status: ScreeningResult['status'] } {
    if (hits.length === 0) return { riskScore: 0, riskLevel: 'low', status: 'clear' };

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

    if (riskScore >= 75) { riskLevel = 'critical'; status = 'escalated'; }
    else if (riskScore >= 50) { riskLevel = 'high'; status = 'hit'; }
    else if (riskScore >= 25) { riskLevel = 'medium'; status = 'review_required'; }
    else { riskLevel = 'low'; status = 'review_required'; }

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
    if (hits.length === 0) return 'No matches found across configured watchlists.';
    const alerts = hits.filter((h) => h.severity === 'alert').length;
    const warnings = hits.filter((h) => h.severity === 'warning').length;
    return `${hits.length} match(es) found — ${alerts} alert(s), ${warnings} warning(s). Risk level: ${riskLevel.toUpperCase()}.`;
  }

  private buildRecommendation(
    riskLevel: string,
    hits: ScreeningHit[],
  ): string {
    switch (riskLevel) {
      case 'critical': return 'Immediate escalation required. Do not proceed without MLRO sign-off. File SAR if applicable.';
      case 'high': return 'Refer to compliance officer for Enhanced Due Diligence (EDD). Do not onboard until cleared.';
      case 'medium': return 'Flag for analyst review. Obtain additional identity documentation before proceeding.';
      default: return hits.length > 0 ? 'Low confidence matches noted. Proceed with standard verification.' : 'No action required. Proceed normally.';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private listMatchesTypes(entry: WatchlistEntry, types: ScreeningType[]): boolean {
    if (types.includes('sanctions') && ['ofac', 'eu', 'un', 'uk_hmt', 'uae_local'].includes(entry.listSource)) return true;
    if (types.includes('watchlist') && entry.listSource === 'custom') return true;
    if (types.includes('pep') && entry.listSource === 'custom') return true;
    return types.some((t) => t === entry.listSource as string);
  }

  private entryToScreeningType(entry: WatchlistEntry): ScreeningType {
    if (['ofac', 'eu', 'un', 'uk_hmt', 'uae_local'].includes(entry.listSource)) return 'sanctions';
    if (entry.listSource === 'custom') return 'watchlist';
    return 'watchlist';
  }
}
