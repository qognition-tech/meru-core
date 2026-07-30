import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VesselPosition } from '../entities/vessel-position.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

// `ais-decoder` decodes AIVDM/AIVDO NMEA sentences. CommonJS, no bundled types
// — see scripts/check-cjs-deps.js for why that constraint is load-bearing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AisDecode } = require('ais-decoder');

interface DecodedAis {
  valid: boolean;
  aistype?: number;
  mmsi?: number;
  imo?: number;
  shipname?: string;
  callsign?: string;
  cargo?: number;
  destination?: string;
  lat?: number;
  lon?: number;
  sog?: number;
  cog?: number;
  hdg?: number;
  navstatus?: number;
}

/** AIS navigational status codes (ITU-R M.1371 table 45). */
const NAV_STATUS: Record<number, string> = {
  0: 'under_way_using_engine',
  1: 'at_anchor',
  2: 'not_under_command',
  3: 'restricted_manoeuvrability',
  4: 'constrained_by_draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged_in_fishing',
  8: 'under_way_sailing',
  15: 'undefined',
};

export interface AisIngestResult {
  received: number;
  decoded: number;
  vesselsUpdated: number;
  ignored: number;
  errors: string[];
}

/**
 * Ingests raw AIS.
 *
 * This is what makes vessel tracking work without a paid HTTP provider: point
 * any AIS source — a dockside receiver, an aggregator feed, AISStream — at the
 * ingest endpoint and positions land here. The engine reads them when no
 * commercial API is configured.
 *
 * Raw NMEA is decoded in-process with `ais-decoder` rather than hand-parsing
 * the 6-bit ASCII payload. AIS bit-packing is unforgiving and getting it
 * slightly wrong yields plausible-looking coordinates in the wrong ocean.
 */
@Injectable()
export class AisIngestService {
  private readonly logger = new Logger(AisIngestService.name);

  constructor(
    @InjectRepository(VesselPosition)
    private readonly positionRepo: Repository<VesselPosition>,
  ) {}

  /**
   * Decode a batch of AIVDM/AIVDO sentences and upsert the vessels they describe.
   *
   * The `session` object is shared across the batch on purpose: type-5 static
   * reports are split across two sentences, and the decoder accumulates the
   * fragments in it. Decoding each sentence with a fresh session would silently
   * drop every multi-part message — which is all of the identity data.
   */
  async ingestNmea(sentences: string[]): Promise<AisIngestResult> {
    const result: AisIngestResult = {
      received: sentences.length,
      decoded: 0,
      vesselsUpdated: 0,
      ignored: 0,
      errors: [],
    };

    const session: Record<string, unknown> = {};
    const byMmsi = new Map<string, Partial<VesselPosition>>();

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      let decoded: DecodedAis;
      try {
        decoded = new AisDecode(trimmed, session) as DecodedAis;
      } catch (error) {
        result.errors.push(
          `${trimmed.slice(0, 24)}…: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      // The first half of a multi-part message is not an error — the decoder
      // reports it as not-yet-valid and completes on the second fragment.
      if (!decoded.valid || !decoded.mmsi) {
        result.ignored++;
        continue;
      }

      result.decoded++;
      const mmsi = String(decoded.mmsi);
      const merged = byMmsi.get(mmsi) ?? { mmsi };

      // Merge rather than replace: a position report and a static report for
      // the same vessel each carry half the picture.
      if (decoded.lat !== undefined && Number.isFinite(decoded.lat)) {
        merged.lat = decoded.lat;
        merged.lon = decoded.lon ?? null;
        merged.sog = decoded.sog ?? null;
        merged.cog = decoded.cog ?? null;
        merged.heading = decoded.hdg ?? null;
        merged.navStatus =
          decoded.navstatus !== undefined
            ? (NAV_STATUS[decoded.navstatus] ?? String(decoded.navstatus))
            : null;
      }

      if (decoded.shipname) merged.name = decoded.shipname.trim();
      if (decoded.imo) merged.imo = String(decoded.imo);
      if (decoded.callsign) merged.callSign = decoded.callsign.trim();
      if (decoded.destination) merged.destination = decoded.destination.trim();
      if (decoded.mmsi) merged.flag = this.flagFromMmsi(mmsi);

      byMmsi.set(mmsi, merged);
    }

    for (const [mmsi, fields] of byMmsi) {
      try {
        await this.upsert(mmsi, { ...fields, source: 'nmea' });
        result.vesselsUpdated++;
      } catch (error) {
        result.errors.push(
          `${mmsi}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `AIS ingest: ${result.decoded}/${result.received} decoded, ` +
        `${result.vesselsUpdated} vessels updated`,
    );

    return result;
  }

  /**
   * Ingest already-decoded positions — the shape most aggregator APIs
   * (AISStream, AISHub) emit, so a feed adapter does not have to re-encode
   * back to NMEA just to use this path.
   */
  async ingestPositions(
    positions: Array<Partial<VesselPosition> & { mmsi: string }>,
  ): Promise<AisIngestResult> {
    const result: AisIngestResult = {
      received: positions.length,
      decoded: positions.length,
      vesselsUpdated: 0,
      ignored: 0,
      errors: [],
    };

    for (const p of positions) {
      if (!p.mmsi) {
        result.ignored++;
        continue;
      }
      try {
        await this.upsert(String(p.mmsi), { ...p, source: p.source ?? 'json' });
        result.vesselsUpdated++;
      } catch (error) {
        result.errors.push(
          `${p.mmsi}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  }

  /** Latest state for a vessel, by IMO or MMSI. */
  async find(identifiers: {
    imo?: string;
    mmsi?: string;
  }): Promise<VesselPosition | null> {
    if (!identifiers.imo && !identifiers.mmsi) return null;

    // `vessel_positions` is platform-global: readable by any tenant, written
    // only under bypass. Reads run in a system context because the row has no
    // tenantId for a policy to match on.
    return TenantContext.runAsSystem('read global AIS position', async () => {
      if (identifiers.mmsi) {
        const byMmsi = await this.positionRepo.findOne({
          where: { mmsi: String(identifiers.mmsi) },
        });
        if (byMmsi) return byMmsi;
      }
      if (identifiers.imo) {
        return this.positionRepo.findOne({
          where: { imo: String(identifiers.imo).replace(/^IMO/i, '') },
        });
      }
      return null;
    });
  }

  private async upsert(mmsi: string, fields: Partial<VesselPosition>) {
    return TenantContext.runAsSystem('write global AIS position', async () => {
      const existing = await this.positionRepo.findOne({ where: { mmsi } });

      if (existing) {
        // Only overwrite with values the new report actually carried —
        // otherwise a position-only report would blank out the vessel's name.
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined && value !== null) {
            (existing as any)[key] = value;
          }
        }
        existing.lastSeenAt = new Date();
        return this.positionRepo.save(existing);
      }

      return this.positionRepo.save(
        this.positionRepo.create({
          ...fields,
          mmsi,
          lastSeenAt: new Date(),
        }),
      );
    });
  }

  /**
   * Flag state from the MMSI's Maritime Identification Digits (first three).
   *
   * A useful signal on its own: a vessel broadcasting an MID for a sanctioned
   * jurisdiction is worth noticing even before any list is consulted. Only the
   * MIDs relevant to the Common Corridor and current sanctions programmes are
   * mapped; everything else returns null rather than a guess.
   */
  private flagFromMmsi(mmsi: string): string | null {
    const mid = mmsi.slice(0, 3);
    const MIDS: Record<string, string> = {
      '470': 'AE',
      '471': 'AE',
      '403': 'SA',
      '425': 'IQ',
      '422': 'IR',
      '428': 'SY',
      '408': 'BH',
      '447': 'QA',
      '445': 'KP',
      '412': 'CN',
      '413': 'CN',
      '414': 'CN',
      '273': 'RU',
      '432': 'JP',
      '235': 'GB',
      '232': 'GB',
      '233': 'GB',
      '234': 'GB',
      '316': 'CA',
      '338': 'US',
      '366': 'US',
      '367': 'US',
      '368': 'US',
      '369': 'US',
      '503': 'AU',
      '512': 'NZ',
      '353': 'PA',
      '354': 'PA',
      '355': 'PA',
      '636': 'LR',
      '538': 'MH',
      '775': 'VE',
    };
    return MIDS[mid] ?? null;
  }
}
