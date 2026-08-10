import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistEntry } from '../entities/watchlist-entry.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/**
 * Ingests official sanctions lists into `watchlist_entries`.
 *
 * The screening engine shipped with real matching algorithms but a hardcoded
 * array of a dozen sample designations, so it could never produce a true
 * positive against a real name. These sources are the free, public,
 * no-authentication feeds — no vendor licence required:
 *
 *  - OFAC SDN (US Treasury), CSV
 *  - UN Security Council Consolidated List, XML
 *
 * EU and UK HMT publish equivalents but behind formats that change without
 * notice; they are declared here and left unimplemented rather than shipped
 * as a parser that silently yields zero rows.
 *
 * Runs from /jobs/tick (daily), never a @Cron — those do not fire on Vercel.
 */
@Injectable()
export class WatchlistIngestService {
  private readonly logger = new Logger(WatchlistIngestService.name);

  constructor(
    @InjectRepository(WatchlistEntry)
    private readonly watchlistRepo: Repository<WatchlistEntry>,
  ) {}

  /** Same normalization the engine applies to candidate names. */
  static normalize(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async ingestAll(): Promise<{
    sources: Record<string, number | string>;
    total: number;
  }> {
    const sources: Record<string, number | string> = {};
    let total = 0;

    for (const [source, loader] of [
      ['ofac', () => this.fetchOfacSdn()],
      ['un', () => this.fetchUnConsolidated()],
      ['eu', () => this.fetchEuCfsp()],
      ['uk', () => this.fetchUkOfsi()],
    ] as const) {
      try {
        const entries = await loader();
        if (entries.length === 0) {
          // A feed that parses to nothing is a broken parser, not an empty
          // sanctions list. Never let it wipe the stored rows.
          sources[source] = 'skipped: feed returned no parsable entries';
          this.logger.warn(`Watchlist ${source}: no entries parsed, skipping`);
          continue;
        }
        const written = await this.upsert(source, entries);
        sources[source] = written;
        total += written;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sources[source] = `failed: ${message}`;
        this.logger.error(`Watchlist ${source} ingestion failed: ${message}`);
      }
    }

    return { sources, total };
  }

  private async upsert(
    listSource: string,
    entries: Array<Omit<Partial<WatchlistEntry>, 'listSource'>>,
  ): Promise<number> {
    return TenantContext.runAsSystem(
      `watchlist ingest ${listSource}`,
      async () => {
        const now = new Date();
        let written = 0;

        // Chunked: a single 17k-row insert exceeds the parameter limit.
        const CHUNK = 500;
        for (let i = 0; i < entries.length; i += CHUNK) {
          const chunk = entries.slice(i, i + CHUNK).map((e) => ({
            ...e,
            listSource,
            lastSeenAt: now,
          }));
          await this.watchlistRepo
            .createQueryBuilder()
            .insert()
            .into(WatchlistEntry)
            .values(chunk)
            .orUpdate(
              ['name', 'normalizedName', 'aliases', 'entityType', 'country', 'programs', 'remarks', 'lastSeenAt'],
              ['listSource', 'externalId'],
            )
            .execute();
          written += chunk.length;
        }

        // Delisting is meaningful: a name removed from OFAC must stop
        // producing hits. Anything not seen in this run is gone from the feed.
        const stale = await this.watchlistRepo
          .createQueryBuilder()
          .delete()
          .where('"listSource" = :listSource', { listSource })
          .andWhere('("lastSeenAt" IS NULL OR "lastSeenAt" < :now)', { now })
          .execute();

        this.logger.log(
          `Watchlist ${listSource}: ${written} upserted, ${stale.affected ?? 0} delisted`,
        );
        return written;
      },
    );
  }

  /** OFAC Specially Designated Nationals — public CSV, no key. */
  private async fetchOfacSdn(): Promise<Partial<WatchlistEntry>[]> {
    const res = await fetch('https://www.treasury.gov/ofac/downloads/sdn.csv', {
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`OFAC SDN returned HTTP ${res.status}`);
    const csv = await res.text();

    const entries: Partial<WatchlistEntry>[] = [];
    for (const line of csv.split('\n')) {
      // Fixed 12-column layout: uid, name, type, program, title, callSign,
      // vesselType, tonnage, grt, vesselFlag, vesselOwner, remarks.
      const cols = this.parseCsvLine(line);
      if (cols.length < 4) continue;
      const [uid, name, type, program, , , , , , , , remarks] = cols;
      if (!uid || !name || name === '-0- ') continue;

      entries.push({
        externalId: uid.trim(),
        name: name.trim(),
        normalizedName: WatchlistIngestService.normalize(name),
        aliases: [],
        entityType:
          type?.trim().toLowerCase() === 'individual'
            ? 'individual'
            : 'organization',
        country: null,
        programs: program ? [program.trim()] : [],
        remarks: remarks?.trim() || null,
      });
    }
    return entries;
  }

  /** UN Security Council Consolidated List — public XML, no key. */
  private async fetchUnConsolidated(): Promise<Partial<WatchlistEntry>[]> {
    const res = await fetch(
      'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
      { signal: AbortSignal.timeout(45_000) },
    );
    if (!res.ok) throw new Error(`UN list returned HTTP ${res.status}`);
    const xml = await res.text();

    const entries: Partial<WatchlistEntry>[] = [];
    // Regex rather than a DOM parser: the document is ~10MB and the shape is
    // stable and flat. A full parse would blow the function memory budget.
    const blocks = xml.match(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g) ?? [];
    for (const block of blocks) {
      const isIndividual = block.startsWith('<INDIVIDUAL>');
      const pick = (tag: string) =>
        new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1]?.trim();

      const dataid = pick('DATAID');
      const nameParts = [
        pick('FIRST_NAME'),
        pick('SECOND_NAME'),
        pick('THIRD_NAME'),
        pick('FOURTH_NAME'),
      ].filter(Boolean);
      const name = nameParts.join(' ').trim();
      if (!dataid || !name) continue;

      const aliases = (block.match(/<ALIAS_NAME>([\s\S]*?)<\/ALIAS_NAME>/g) ?? [])
        .map((a) => a.replace(/<\/?ALIAS_NAME>/g, '').trim())
        .filter(Boolean);

      entries.push({
        externalId: dataid,
        name,
        normalizedName: WatchlistIngestService.normalize(name),
        aliases,
        entityType: isIndividual ? 'individual' : 'organization',
        country: null,
        programs: [pick('UN_LIST_TYPE') ?? 'UN'].filter(Boolean) as string[],
        remarks: pick('COMMENTS1') || null,
      });
    }
    return entries;
  }

  /**
   * EU Consolidated Financial Sanctions List (CFSP) — public XML, no key.
   *
   * The published feed is the "fsf" export from the Commission's FISMA site.
   * Names arrive as one `nameAlias` element per spelling with no primary
   * marked, so the first alias for a subject becomes the name and the rest
   * become aliases — which is what the screening engine wants anyway, since it
   * matches against aliases with the same algorithms.
   */
  private async fetchEuCfsp(): Promise<Partial<WatchlistEntry>[]> {
    const res = await fetch(
      'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`EU CFSP returned HTTP ${res.status}`);
    const xml = await res.text();

    const entries: Partial<WatchlistEntry>[] = [];
    const blocks = xml.match(/<sanctionEntity[\s\S]*?<\/sanctionEntity>/g) ?? [];

    for (const block of blocks) {
      const logicalId = /logicalId="(\d+)"/.exec(block)?.[1];
      if (!logicalId) continue;

      // `wholeName` is present on most aliases; fall back to the first/last
      // pair when it is not, rather than dropping the subject.
      const names = [...block.matchAll(/<nameAlias\b[^>]*\/?>/g)]
        .map((m) => {
          const tag = m[0];
          const whole = /wholeName="([^"]*)"/.exec(tag)?.[1];
          if (whole?.trim()) return whole.trim();
          const first = /firstName="([^"]*)"/.exec(tag)?.[1] ?? '';
          const last = /lastName="([^"]*)"/.exec(tag)?.[1] ?? '';
          return `${first} ${last}`.trim();
        })
        .filter((n) => n.length > 1);

      if (names.length === 0) continue;

      // `<subjectType code="person" classificationCode="P"/>`. Matching on
      // `code="P"` instead — the obvious first guess — matches nothing, and
      // the failure is silent: every designated person is filed as an
      // organization and still screens, so nothing looks broken.
      const isPerson = /<subjectType[^>]*classificationCode="P"/.test(block);
      const country = /<citizenship[^>]*countryIso2Code="([A-Z]{2})"/.exec(
        block,
      )?.[1];
      const programme = /<regulation[^>]*programme="([^"]*)"/.exec(block)?.[1];

      entries.push({
        externalId: logicalId,
        name: names[0],
        normalizedName: WatchlistIngestService.normalize(names[0]),
        aliases: names.slice(1),
        entityType: isPerson ? 'individual' : 'organization',
        country: country ?? null,
        programs: programme ? [programme] : ['EU'],
        remarks: null,
      });
    }
    return entries;
  }

  /**
   * UK OFSI consolidated list — public CSV, no key.
   *
   * Served from OFSI's own blob storage rather than a gov.uk asset URL: those
   * carry a numeric attachment id that changes on every publication, so a
   * hardcoded one 404s within weeks. This URL is stable across publications.
   *
   * Two shapes have to be undone. The real header is on the **second** line —
   * the first is `Last Updated,<date>`. And OFSI publishes one row per
   * *alias*, keyed by `Group ID`, so a subject with six spellings is six rows;
   * they are folded into one entry per group, because six rows for one person
   * makes a single true match look like six hits.
   *
   * Names are assembled `Name 1..5` (forenames, in order) + `Name 6`
   * (surname), which is OFSI's column convention and not guessable from the
   * headers alone.
   */
  private async fetchUkOfsi(): Promise<Partial<WatchlistEntry>[]> {
    const res = await fetch(
      'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv',
      { signal: AbortSignal.timeout(90_000) },
    );
    if (!res.ok) throw new Error(`UK OFSI returned HTTP ${res.status}`);
    const csv = await res.text();

    const lines = csv.replace(/^\uFEFF/, '').split('\n');
    const headerIndex = lines.findIndex((l) => /Group ?ID/i.test(l));
    if (headerIndex === -1) {
      // A parser that yields zero rows must fail loudly, or the daily job
      // reports success while screening quietly loses a list.
      throw new Error('UK OFSI CSV has no recognisable header row');
    }

    const header = this.parseCsvLine(lines[headerIndex]).map((h) =>
      h.trim().toLowerCase(),
    );
    const col = (name: string) => header.findIndex((h) => h === name);

    const iGroup = col('group id');
    const iSurname = col('name 6');
    const iForenames = [1, 2, 3, 4, 5].map((n) => col(`name ${n}`));
    const iType = col('group type');
    const iAliasType = col('alias type');
    const iRegime = col('regime');
    const iCountry = col('country');

    if (iGroup < 0 || iSurname < 0) {
      throw new Error(
        `UK OFSI CSV header changed — no 'Group ID'/'Name 6' column (got ${header.length} columns)`,
      );
    }

    const grouped = new Map<
      string,
      { primary: string | null; aliases: string[]; row: string[] }
    >();

    for (const line of lines.slice(headerIndex + 1)) {
      const cols = this.parseCsvLine(line);
      if (cols.length <= iGroup) continue;

      const groupId = cols[iGroup]?.trim();
      if (!groupId) continue;

      const name = [
        ...iForenames.map((i) => (i >= 0 ? cols[i] : '')),
        cols[iSurname],
      ]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (!name) continue;

      const isPrimary =
        iAliasType >= 0 &&
        /primary/i.test((cols[iAliasType] ?? '').trim());

      const existing = grouped.get(groupId);
      if (!existing) {
        grouped.set(groupId, {
          primary: isPrimary ? name : null,
          aliases: isPrimary ? [] : [name],
          row: cols,
        });
        continue;
      }

      if (isPrimary && !existing.primary) existing.primary = name;
      else if (name !== existing.primary && !existing.aliases.includes(name)) {
        existing.aliases.push(name);
      }
    }

    const entries: Partial<WatchlistEntry>[] = [];
    for (const [groupId, group] of grouped) {
      // No row marked primary: promote the first alias rather than dropping a
      // designated subject over a labelling quirk.
      const name = group.primary ?? group.aliases.shift();
      if (!name) continue;

      const type = (iType >= 0 ? group.row[iType] : '')?.trim().toLowerCase();
      entries.push({
        externalId: groupId,
        name,
        normalizedName: WatchlistIngestService.normalize(name),
        aliases: group.aliases,
        entityType: type?.startsWith('individual') ? 'individual' : 'organization',
        country: null,
        programs: [
          (iRegime >= 0 ? group.row[iRegime]?.trim() : '') || 'UK',
        ].filter(Boolean) as string[],
        remarks: (iCountry >= 0 ? group.row[iCountry]?.trim() : null) || null,
      });
    }

    return entries;
  }

  /**
   * Minimal RFC-4180 line reader. OFAC quotes fields containing commas, so
   * a naive split corrupts every row with a comma in its remarks — which is
   * most of them.
   */
  private parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** Rows available to the screening engine, newest ingest wins. */
  async loadAll(): Promise<WatchlistEntry[]> {
    return TenantContext.runAsSystem('watchlist load for screening', () =>
      this.watchlistRepo.find(),
    );
  }

  async count(): Promise<number> {
    return TenantContext.runAsSystem('watchlist count', () =>
      this.watchlistRepo.count(),
    );
  }

  /**
   * Which lists are loaded and when each was last confirmed against its feed.
   *
   * A total on its own cannot answer "are we screening against the EU list?",
   * so GovX's own page copy claimed "OFAC, UN, EU and CBUAE" while the database
   * held OFAC and UN. The frontend asked for this so it can render the truth
   * instead of maintaining a parallel list, and it is the same principle as
   * `entries: 0` blocking screening: what a UI states about coverage must come
   * from what is actually loaded.
   *
   * `staleDays` is derived from `lastSeenAt`, which the upsert stamps on every
   * row it confirms — so a feed that has silently stopped updating shows as an
   * ageing list rather than a healthy one.
   */
  async inventory(): Promise<{
    entries: number;
    lists: Array<{
      source: string;
      entries: number;
      lastIngestedAt: string | null;
      staleDays: number | null;
    }>;
  }> {
    return TenantContext.runAsSystem('watchlist inventory', async () => {
      const rows = await this.watchlistRepo
        .createQueryBuilder('w')
        .select('w."listSource"', 'source')
        .addSelect('COUNT(*)::int', 'entries')
        .addSelect('MAX(w."lastSeenAt")', 'last')
        .groupBy('w."listSource"')
        .orderBy('entries', 'DESC')
        .getRawMany();

      const now = Date.now();
      const lists = rows.map((r: Record<string, any>) => {
        const last = r.last ? new Date(r.last) : null;
        return {
          source: r.source,
          entries: Number(r.entries),
          lastIngestedAt: last ? last.toISOString() : null,
          staleDays: last
            ? Math.floor((now - last.getTime()) / 86_400_000)
            : null,
        };
      });

      return {
        entries: lists.reduce((sum, l) => sum + l.entries, 0),
        lists,
      };
    });
  }
}
