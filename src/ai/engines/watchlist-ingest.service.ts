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
}
