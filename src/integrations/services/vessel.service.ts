import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityType,
  UniversalEntity,
} from '../../crm/entities/universal-entity.entity';
import { VesselTrackingEngine } from '../../ai/engines/vessel-tracking.engine';
import { AisIngestService } from './ais-ingest.service';

/**
 * A watched vessel as the API returns it.
 *
 * Declared explicitly because the enriched and degraded branches would
 * otherwise infer as a union, and every consumer would have to narrow before
 * reading `riskLevel`. `live` is the discriminator that matters at runtime.
 */
export interface WatchedVessel {
  id: string;
  name: string;
  imo: string | null;
  mmsi: string | null;
  flag: string | null;
  type: string | null;
  addedAt: Date;
  position: unknown | null;
  riskScore: number | null;
  riskLevel: string | null;
  darkPeriods: number;
  /** False when risk could not be established — nulls mean "unknown", not "safe". */
  live: boolean;
  /** `provider` = commercial AIS API; `ingested` = locally ingested feed. */
  source?: 'provider' | 'ingested';
  /** Name of the sanctioned port whose geofence this vessel is inside. */
  sanctionedPort?: string | null;
  /**
   * Why `live` is false. `ais_not_configured` means no feed is wired up at all;
   * `lookup_failed` means the feed was tried and did not answer. The UI must be
   * able to tell those apart — one is an ops task, the other an incident.
   */
  unavailableReason?: 'ais_not_configured' | 'lookup_failed';
}

/**
 * Per-tenant vessel watchlist, layered over the Vessel Tracking engine.
 *
 * A watched vessel is a `UniversalEntity` of type `asset` — CLAUDE.md §2 lists
 * Asset as one of the four polymorphic entity kinds, and a ship is the textbook
 * case. No new table: the identifiers (IMO, MMSI, flag) live in
 * `verticalAttributes`, and everything that moves — position, speed, risk — is
 * fetched live from the engine rather than stored, because a cached AIS
 * position is a wrong AIS position.
 */
@Injectable()
export class VesselService {
  private readonly logger = new Logger(VesselService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    private readonly engine: VesselTrackingEngine,
    private readonly ais: AisIngestService,
  ) {}

  private async watchlistRows(tenantId: string): Promise<UniversalEntity[]> {
    const rows = await this.entityRepo.find({
      where: { tenantId, type: EntityType.ASSET },
      order: { createdAt: 'DESC' },
    });

    // `asset` covers more than ships; only rows carrying a maritime identifier
    // are vessels.
    return rows.filter(
      (r) => r.verticalAttributes?.imo || r.verticalAttributes?.mmsi,
    );
  }

  /**
   * The tenant's watched vessels, each enriched with a live position and risk
   * score.
   *
   * Enrichment is per-vessel and independently fallible: one unreachable AIS
   * lookup degrades that row to its stored identifiers instead of failing the
   * whole page. A partial fleet view is useful; a 500 is not.
   */
  async listWatchlist(tenantId: string): Promise<WatchedVessel[]> {
    const rows = await this.watchlistRows(tenantId);

    return Promise.all(
      rows.map(async (row): Promise<WatchedVessel> => {
        const attrs = row.verticalAttributes ?? {};
        const base = {
          id: row.id,
          name: row.firstName ?? attrs.name ?? 'Unknown vessel',
          imo: attrs.imo ?? null,
          mmsi: attrs.mmsi ?? null,
          flag: attrs.flag ?? null,
          type: attrs.vesselType ?? null,
          addedAt: row.createdAt,
        };

        // Two sources, in order of quality. A commercial AIS API gives
        // history and dark-period analysis; the locally ingested feed gives a
        // last-known fix, which is enough to place a vessel and geofence it.
        if (!this.engine.isConfigured()) {
          const stored = await this.ais.find({
            imo: attrs.imo,
            mmsi: attrs.mmsi,
          });

          // Nothing configured *and* nothing ingested: genuinely unknown.
          // Never report this as clear — see the `unavailableReason` note.
          if (!stored || stored.lat === null || stored.lon === null) {
            return {
              ...base,
              position: null,
              riskScore: null,
              riskLevel: null,
              darkPeriods: 0,
              live: false,
              unavailableReason: 'ais_not_configured',
            };
          }

          // Geofencing is local maths over a known fix, so a sanctioned-port
          // breach is detectable from the ingested feed alone.
          const fence = this.engine.checkGeofence(stored.lat, stored.lon);

          return {
            ...base,
            name: stored.name ?? base.name,
            flag: stored.flag ?? base.flag,
            type: stored.shipType ?? base.type,
            position: {
              lat: stored.lat,
              lon: stored.lon,
              speed: stored.sog,
              course: stored.cog,
              heading: stored.heading,
              navStatus: stored.navStatus,
              destination: stored.destination,
              timestamp: stored.lastSeenAt,
              source: stored.source,
            },
            riskScore: fence.inSanctionedZone ? 90 : 10,
            riskLevel: fence.inSanctionedZone ? 'critical' : 'low',
            sanctionedPort: fence.inSanctionedZone
              ? fence.nearestPort?.name
              : null,
            darkPeriods: 0,
            live: true,
            source: 'ingested',
          };
        }

        try {
          const [info, risk] = await Promise.all([
            this.engine.lookupVessel({ imo: attrs.imo, mmsi: attrs.mmsi }),
            this.engine.assessVesselRisk({ imo: attrs.imo, mmsi: attrs.mmsi }),
          ]);

          return {
            ...base,
            flag: info?.flag ?? base.flag,
            type: info?.type ?? base.type,
            position: info?.currentPosition ?? null,
            riskScore: risk?.score ?? null,
            riskLevel: risk?.overallRisk ?? null,
            darkPeriods: info?.darkPeriods?.length ?? 0,
            live: true,
            source: 'provider',
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `AIS lookup failed for ${base.imo ?? base.mmsi}: ${message}`,
          );
          // `live: false` is the honest signal. Returning stale-looking nulls
          // without it would let the UI present "no risk" when what happened
          // was "we could not check".
          return {
            ...base,
            position: null,
            riskScore: null,
            riskLevel: null,
            darkPeriods: 0,
            live: false,
            unavailableReason: 'lookup_failed',
          };
        }
      }),
    );
  }

  /** Risk signals across the whole watchlist, highest severity first. */
  async listAlerts(tenantId: string) {
    const vessels = await this.listWatchlist(tenantId);

    const rank: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      none: 0,
    };

    return vessels
      .filter((v) => v.riskLevel && v.riskLevel !== 'none')
      .map((v) => ({
        vesselId: v.id,
        vesselName: v.name,
        imo: v.imo,
        severity: (v.riskLevel ?? 'low').toUpperCase(),
        riskScore: v.riskScore,
        darkPeriods: v.darkPeriods ?? 0,
        triggeredAt: new Date(),
      }))
      .sort(
        (a, b) =>
          (rank[b.severity.toLowerCase()] ?? 0) -
          (rank[a.severity.toLowerCase()] ?? 0),
      );
  }

  async addToWatchlist(
    tenantId: string,
    dto: {
      name?: string;
      imo?: string;
      mmsi?: string;
      flag?: string;
      vesselType?: string;
    },
  ) {
    const existing = await this.watchlistRows(tenantId);
    const duplicate = existing.find(
      (r) =>
        (dto.imo && r.verticalAttributes?.imo === dto.imo) ||
        (dto.mmsi && r.verticalAttributes?.mmsi === dto.mmsi),
    );

    // Idempotent: re-adding a vessel already on the list returns it rather than
    // creating a second row that would then double-count in the alert feed.
    if (duplicate) {
      return { id: duplicate.id, alreadyWatched: true };
    }

    const entity = await this.entityRepo.save(
      this.entityRepo.create({
        tenantId,
        type: EntityType.ASSET,
        firstName: dto.name ?? dto.imo ?? dto.mmsi,
        verticalAttributes: {
          imo: dto.imo,
          mmsi: dto.mmsi,
          flag: dto.flag,
          vesselType: dto.vesselType,
          kind: 'vessel',
        },
      }),
    );

    return { id: entity.id, alreadyWatched: false };
  }

  async removeFromWatchlist(tenantId: string, id: string) {
    const result = await this.entityRepo.delete({
      id,
      tenantId,
      type: EntityType.ASSET,
    });

    if (!result.affected) {
      throw new NotFoundException('Vessel not on this tenant’s watchlist');
    }

    return { removed: true, id };
  }
}
