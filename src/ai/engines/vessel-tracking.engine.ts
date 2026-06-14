import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VesselLookupRequest {
  mmsi?: string;
  imo?: string;
  vesselName?: string;
}

export interface AisPosition {
  lat: number;
  lon: number;
  speed: number;       // knots
  course: number;      // degrees
  heading: number;
  navStatus: string;
  timestamp: Date;
  source: string;
}

export interface VesselInfo {
  mmsi: string;
  imo?: string;
  name: string;
  flag?: string;
  type?: string;
  grossTonnage?: number;
  yearBuilt?: number;
  callSign?: string;
  currentPosition?: AisPosition;
  positionHistory?: AisPosition[];
  darkPeriods?: DarkPeriod[];
}

export interface DarkPeriod {
  startedAt: Date;
  endedAt: Date | null;
  durationHours: number;
  lastKnownPosition?: { lat: number; lon: number };
  nearSanctionedPort: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface SanctionedPort {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  radiusKm: number;
  sanctionBasis: string; // e.g. "OFAC", "EU", "UN"
}

export interface VesselRiskScore {
  mmsi: string;
  overallRisk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  score: number;          // 0–100
  signals: RiskSignal[];
  assessedAt: Date;
  sanctionedPortCalls: SanctionedPortCall[];
  darkPeriods: DarkPeriod[];
  lastPosition?: AisPosition;
}

export interface RiskSignal {
  type:
    | 'sanctioned_port_proximity'
    | 'dark_period'
    | 'flag_risk'
    | 'imo_mismatch'
    | 'ais_manipulation'
    | 'voyage_anomaly';
  severity: 'low' | 'medium' | 'high';
  details: string;
  weight: number;
}

export interface SanctionedPortCall {
  port: SanctionedPort;
  enteredAt?: Date;
  exitedAt?: Date;
  distanceKm: number;
}

// ── Sanctioned/restricted port list ──────────────────────────────────────
// Maintained by OFAC / EU / UN sanctions. Lat/lon are port centroids.

const SANCTIONED_PORTS: SanctionedPort[] = [
  // Iran
  { code: 'IRBND', name: 'Bandar Abbas', country: 'IR', lat: 27.18, lon: 56.28, radiusKm: 25, sanctionBasis: 'OFAC/EU/UN' },
  { code: 'IRKHO', name: 'Kharg Island', country: 'IR', lat: 29.24, lon: 50.33, radiusKm: 15, sanctionBasis: 'OFAC/EU' },
  { code: 'IRIMK', name: 'Imam Khomeini Port', country: 'IR', lat: 30.45, lon: 49.08, radiusKm: 20, sanctionBasis: 'OFAC/EU/UN' },
  // North Korea
  { code: 'KPNAM', name: 'Nampo', country: 'KP', lat: 38.73, lon: 125.40, radiusKm: 20, sanctionBasis: 'OFAC/EU/UN' },
  { code: 'KPCJN', name: 'Chongjin', country: 'KP', lat: 41.78, lon: 129.78, radiusKm: 15, sanctionBasis: 'OFAC/EU/UN' },
  // Syria
  { code: 'SYLAT', name: 'Latakia', country: 'SY', lat: 35.52, lon: 35.78, radiusKm: 15, sanctionBasis: 'EU/UK' },
  { code: 'SYTAR', name: 'Tartus', country: 'SY', lat: 34.89, lon: 35.88, radiusKm: 10, sanctionBasis: 'EU/UK' },
  // Russia (post-2022 maritime sanctions)
  { code: 'RUNSB', name: 'Novorossiysk', country: 'RU', lat: 44.73, lon: 37.77, radiusKm: 20, sanctionBasis: 'EU/UK/US' },
  { code: 'RUVNN', name: 'Vladivostok', country: 'RU', lat: 43.11, lon: 131.87, radiusKm: 20, sanctionBasis: 'EU/UK' },
  { code: 'RUSES', name: 'Saint Petersburg (sea terminals)', country: 'RU', lat: 59.94, lon: 30.19, radiusKm: 25, sanctionBasis: 'EU/UK' },
  // Venezuela
  { code: 'VEPBL', name: 'Puerto Cabello', country: 'VE', lat: 10.48, lon: -68.01, radiusKm: 15, sanctionBasis: 'OFAC' },
  { code: 'VECCS', name: 'La Guaira', country: 'VE', lat: 10.60, lon: -66.93, radiusKm: 10, sanctionBasis: 'OFAC' },
  // Myanmar
  { code: 'MMRGN', name: 'Yangon', country: 'MM', lat: 16.77, lon: 96.17, radiusKm: 15, sanctionBasis: 'EU/UK/US' },
  // Belarus transhipment hubs
  { code: 'BYKLP', name: 'Klaipeda (Belarus transshipment)', country: 'LT', lat: 55.71, lon: 21.13, radiusKm: 10, sanctionBasis: 'EU' },
];

// High-risk flag states (indicative, not exhaustive)
const HIGH_RISK_FLAGS = new Set([
  'KP', // North Korea
  'IR', // Iran
  'SY', // Syria
  'VE', // Venezuela
  'CU', // Cuba
  'BY', // Belarus
  'PW', // Palau (open registry with poor oversight)
  'COM', // Comoros (open registry)
  'MH', // Marshall Islands (some concerns)
]);

// AIS dark period thresholds
const DARK_PERIOD_THRESHOLD_HOURS = 6;
const DARK_PERIOD_HIGH_RISK_HOURS = 24;

// ── VesselTrackingEngine ──────────────────────────────────────────────────

@Injectable()
export class VesselTrackingEngine {
  private readonly logger = new Logger(VesselTrackingEngine.name);
  private readonly aisApiUrl: string | null;
  private readonly aisApiKey: string | null;
  private readonly fetchTimeoutMs = 15_000;

  constructor(private readonly configService: ConfigService) {
    this.aisApiUrl = configService.get<string>('AIS_API_URL') ?? null;
    this.aisApiKey = configService.get<string>('AIS_API_KEY') ?? null;

    if (!this.aisApiUrl || !this.aisApiKey) {
      this.logger.warn(
        'Vessel Tracking: AIS_API_URL or AIS_API_KEY not configured — ' +
          'engine will return risk assessments without live AIS data',
      );
    } else {
      this.logger.log(
        `Vessel Tracking Engine ready — AIS endpoint: ${this.aisApiUrl}`,
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async assessVesselRisk(request: VesselLookupRequest): Promise<VesselRiskScore> {
    const identifier = request.mmsi ?? request.imo ?? request.vesselName ?? 'unknown';
    this.logger.log(`Vessel risk assessment requested: ${identifier}`);

    let vesselInfo: VesselInfo | null = null;

    try {
      vesselInfo = await this.lookupVessel(request);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AIS lookup failed for ${identifier}: ${msg}`);
    }

    return this.computeRiskScore(request, vesselInfo);
  }

  async lookupVessel(request: VesselLookupRequest): Promise<VesselInfo | null> {
    if (!this.aisApiUrl || !this.aisApiKey) {
      return null;
    }

    const params = new URLSearchParams();
    if (request.mmsi) params.set('mmsi', request.mmsi);
    if (request.imo) params.set('imo', request.imo);
    if (request.vesselName) params.set('name', request.vesselName);

    const url = `${this.aisApiUrl}/vessel?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.aisApiKey}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`AIS API returned ${response.status}`);
      }

      const data = await response.json() as any;
      return this.normaliseAisResponse(data);
    } finally {
      clearTimeout(timer);
    }
  }

  checkGeofence(
    lat: number,
    lon: number,
  ): { inSanctionedZone: boolean; nearestPort: SanctionedPort | null; distanceKm: number } {
    let minDistance = Infinity;
    let nearestPort: SanctionedPort | null = null;

    for (const port of SANCTIONED_PORTS) {
      const dist = this.haversineKm(lat, lon, port.lat, port.lon);
      if (dist < minDistance) {
        minDistance = dist;
        nearestPort = port;
      }
    }

    const inSanctionedZone =
      nearestPort !== null && minDistance <= nearestPort.radiusKm;

    return {
      inSanctionedZone,
      nearestPort,
      distanceKm: minDistance,
    };
  }

  getSanctionedPorts(): SanctionedPort[] {
    return [...SANCTIONED_PORTS];
  }

  detectDarkPeriods(positionHistory: AisPosition[]): DarkPeriod[] {
    if (positionHistory.length < 2) return [];

    const sorted = [...positionHistory].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const darkPeriods: DarkPeriod[] = [];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      const gapHours =
        (curr.timestamp.getTime() - prev.timestamp.getTime()) / 3_600_000;

      if (gapHours >= DARK_PERIOD_THRESHOLD_HOURS) {
        const geofence = this.checkGeofence(prev.lat, prev.lon);
        const riskLevel =
          gapHours >= DARK_PERIOD_HIGH_RISK_HOURS
            ? 'high'
            : geofence.inSanctionedZone
            ? 'high'
            : gapHours >= 12
            ? 'medium'
            : 'low';

        darkPeriods.push({
          startedAt: prev.timestamp,
          endedAt: curr.timestamp,
          durationHours: gapHours,
          lastKnownPosition: { lat: prev.lat, lon: prev.lon },
          nearSanctionedPort: geofence.inSanctionedZone,
          riskLevel,
        });
      }
    }

    return darkPeriods;
  }

  // ── Risk computation ──────────────────────────────────────────────────────

  private computeRiskScore(
    request: VesselLookupRequest,
    info: VesselInfo | null,
  ): VesselRiskScore {
    const signals: RiskSignal[] = [];
    const sanctionedPortCalls: SanctionedPortCall[] = [];
    let darkPeriods: DarkPeriod[] = [];

    const mmsi = request.mmsi ?? info?.mmsi ?? 'unknown';

    // 1. Flag risk
    if (info?.flag && HIGH_RISK_FLAGS.has(info.flag)) {
      signals.push({
        type: 'flag_risk',
        severity: 'high',
        details: `Vessel flagged under high-risk state: ${info.flag}`,
        weight: 30,
      });
    }

    // 2. Current position geofence
    if (info?.currentPosition) {
      const geo = this.checkGeofence(
        info.currentPosition.lat,
        info.currentPosition.lon,
      );
      if (geo.inSanctionedZone && geo.nearestPort) {
        signals.push({
          type: 'sanctioned_port_proximity',
          severity: 'high',
          details: `Vessel within ${geo.distanceKm.toFixed(1)} km of sanctioned port ${geo.nearestPort.name} (${geo.nearestPort.sanctionBasis})`,
          weight: 40,
        });
        sanctionedPortCalls.push({
          port: geo.nearestPort,
          distanceKm: geo.distanceKm,
        });
      } else if (geo.nearestPort && geo.distanceKm <= geo.nearestPort.radiusKm * 3) {
        signals.push({
          type: 'sanctioned_port_proximity',
          severity: 'medium',
          details: `Vessel ${geo.distanceKm.toFixed(1)} km from sanctioned port ${geo.nearestPort.name}`,
          weight: 15,
        });
      }
    }

    // 3. Dark periods from position history
    if (info?.positionHistory && info.positionHistory.length > 0) {
      darkPeriods = this.detectDarkPeriods(info.positionHistory);

      for (const dp of darkPeriods) {
        if (dp.riskLevel === 'high') {
          signals.push({
            type: 'dark_period',
            severity: 'high',
            details: `AIS dark for ${dp.durationHours.toFixed(1)}h starting ${dp.startedAt.toISOString()}${dp.nearSanctionedPort ? ' — last known position near sanctioned port' : ''}`,
            weight: dp.nearSanctionedPort ? 35 : 20,
          });
        } else if (dp.riskLevel === 'medium') {
          signals.push({
            type: 'dark_period',
            severity: 'medium',
            details: `AIS dark for ${dp.durationHours.toFixed(1)}h starting ${dp.startedAt.toISOString()}`,
            weight: 10,
          });
        }
      }
    }

    // 4. Pre-existing dark periods on the info object
    if (info?.darkPeriods) {
      darkPeriods = [...darkPeriods, ...info.darkPeriods];
    }

    // 5. AIS manipulation — MMSI starts with 0 or all same digits
    if (mmsi !== 'unknown') {
      if (/^0/.test(mmsi) || /^(.)\1+$/.test(mmsi)) {
        signals.push({
          type: 'ais_manipulation',
          severity: 'high',
          details: `Suspicious MMSI pattern: ${mmsi}`,
          weight: 25,
        });
      }
    }

    // ── Score aggregation ─────────────────────────────────────────────────
    const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
    const score = Math.min(100, rawScore);

    const overallRisk: VesselRiskScore['overallRisk'] =
      score >= 80
        ? 'critical'
        : score >= 60
        ? 'high'
        : score >= 35
        ? 'medium'
        : score >= 10
        ? 'low'
        : 'none';

    return {
      mmsi,
      overallRisk,
      score,
      signals,
      assessedAt: new Date(),
      sanctionedPortCalls,
      darkPeriods,
      lastPosition: info?.currentPosition,
    };
  }

  // ── AIS response normalisation ────────────────────────────────────────────
  // Normalises responses from different AIS providers into VesselInfo.
  // Supported: MarineTraffic-style JSON, AISHub-style JSON.

  private normaliseAisResponse(raw: any): VesselInfo {
    // MarineTraffic-style
    if (raw.MMSI || raw.mmsi) {
      const pos = raw.AIS || raw.position || raw;
      const history: AisPosition[] = (raw.track || raw.positions || []).map(
        (p: any) => ({
          lat: Number(p.LAT ?? p.lat),
          lon: Number(p.LON ?? p.lon),
          speed: Number(p.SPEED ?? p.speed ?? 0),
          course: Number(p.COURSE ?? p.course ?? 0),
          heading: Number(p.HEADING ?? p.heading ?? 0),
          navStatus: String(p.STATUS ?? p.navStatus ?? ''),
          timestamp: new Date(p.TIMESTAMP ?? p.timestamp ?? Date.now()),
          source: 'ais',
        }),
      );

      return {
        mmsi: String(raw.MMSI ?? raw.mmsi),
        imo: raw.IMO ? String(raw.IMO) : undefined,
        name: String(raw.SHIPNAME ?? raw.name ?? ''),
        flag: String(raw.FLAG ?? raw.flag ?? ''),
        type: String(raw.SHIPTYPE ?? raw.type ?? ''),
        grossTonnage: raw.GRT ? Number(raw.GRT) : undefined,
        yearBuilt: raw.YEAR_BUILT ? Number(raw.YEAR_BUILT) : undefined,
        callSign: raw.CALLSIGN ?? raw.callSign,
        currentPosition:
          pos.LAT !== undefined || pos.lat !== undefined
            ? {
                lat: Number(pos.LAT ?? pos.lat),
                lon: Number(pos.LON ?? pos.lon),
                speed: Number(pos.SPEED ?? pos.speed ?? 0),
                course: Number(pos.COURSE ?? pos.course ?? 0),
                heading: Number(pos.HEADING ?? pos.heading ?? 0),
                navStatus: String(pos.STATUS ?? pos.navStatus ?? ''),
                timestamp: new Date(pos.TIMESTAMP ?? pos.timestamp ?? Date.now()),
                source: 'ais',
              }
            : undefined,
        positionHistory: history,
      };
    }

    // Generic fallback
    return {
      mmsi: String(raw.mmsi ?? raw.id ?? ''),
      name: String(raw.name ?? raw.vessel_name ?? ''),
      flag: raw.flag ?? raw.country,
      currentPosition: raw.lat && raw.lon
        ? {
            lat: Number(raw.lat),
            lon: Number(raw.lon),
            speed: Number(raw.speed ?? 0),
            course: Number(raw.course ?? 0),
            heading: Number(raw.heading ?? 0),
            navStatus: String(raw.nav_status ?? ''),
            timestamp: new Date(raw.timestamp ?? Date.now()),
            source: 'ais',
          }
        : undefined,
    };
  }

  // ── Haversine formula ─────────────────────────────────────────────────────

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth radius in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}
