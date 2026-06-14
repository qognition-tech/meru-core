import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RadarSource {
  id: string;
  regulatorCode: string;
  country: string;
  vertical: string;
  url: string;
  description: string;
  selector?: string; // CSS-like hint for what section matters (informational)
}

export interface RadarChange {
  sourceId: string;
  regulatorCode: string;
  country: string;
  vertical: string;
  url: string;
  description: string;
  previousHash: string | null;
  currentHash: string;
  detectedAt: Date;
  // Human-readable summary of what changed (populated by AI when key available)
  changeSummary?: string;
  // Proposed config-pack diff path (for human review)
  proposedDiffPath?: string;
  status: 'pending_review' | 'acknowledged' | 'applied';
}

export interface RadarScanResult {
  scannedAt: Date;
  sourcesScanned: number;
  changesDetected: number;
  errors: number;
  changes: RadarChange[];
}

// ── Monitored regulatory sources ────────────────────────────────────────────
// Each entry is a canonical page that regulators update when rules change.
// These are public landing pages — the hash detects ANY content update.

const MONITORED_SOURCES: RadarSource[] = [
  // ── Australia ─────────────────────────────────────────────────────────────
  {
    id: 'au-homeaffairs-visa-listing',
    regulatorCode: 'au-home-affairs',
    country: 'AU',
    vertical: 'immigration',
    url: 'https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing',
    description: 'AU HomeAffairs — visa listing page (all visa subclasses)',
  },
  {
    id: 'au-homeaffairs-policy-changes',
    regulatorCode: 'au-home-affairs',
    country: 'AU',
    vertical: 'immigration',
    url: 'https://immi.homeaffairs.gov.au/help-support/migration-resources/migration-legislation-amendment',
    description: 'AU HomeAffairs — legislative amendment notices',
  },
  // ── UAE ───────────────────────────────────────────────────────────────────
  {
    id: 'cbuae-regulations',
    regulatorCode: 'uae-central-bank',
    country: 'AE',
    vertical: 'banking',
    url: 'https://www.centralbank.ae/en/publications/regulations',
    description: 'CBUAE — regulatory publications and circulars',
  },
  {
    id: 'uaefiu-sanctions',
    regulatorCode: 'uae-central-bank',
    country: 'AE',
    vertical: 'banking',
    url: 'https://www.uaefiu.gov.ae/en/Guidance/guidelines',
    description: 'UAE FIU — AML/CFT guidance updates',
  },
  // ── Saudi Arabia ──────────────────────────────────────────────────────────
  {
    id: 'sama-regulations',
    regulatorCode: 'sa-sama',
    country: 'SA',
    vertical: 'banking',
    url: 'https://www.sama.gov.sa/en-US/Rules/Pages/Regulations.aspx',
    description: 'SAMA — regulations and rules',
  },
  // ── Canada ────────────────────────────────────────────────────────────────
  {
    id: 'ircc-news',
    regulatorCode: 'ca-ircc',
    country: 'CA',
    vertical: 'immigration',
    url: 'https://www.canada.ca/en/immigration-refugees-citizenship/news.html',
    description: 'IRCC — immigration news and policy announcements',
  },
  {
    id: 'ircc-fees',
    regulatorCode: 'ca-ircc',
    country: 'CA',
    vertical: 'immigration',
    url: 'https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/fees.html',
    description: 'IRCC — fee schedule',
  },
  // ── United Kingdom ────────────────────────────────────────────────────────
  {
    id: 'uk-homeoffice-immigration-rules',
    regulatorCode: 'uk-home-office',
    country: 'GB',
    vertical: 'immigration',
    url: 'https://www.gov.uk/guidance/immigration-rules',
    description: 'UK Home Office — Immigration Rules (appendices and changes)',
  },
  {
    id: 'uk-fca-sanctions',
    regulatorCode: 'uk-home-office',
    country: 'GB',
    vertical: 'banking',
    url: 'https://www.gov.uk/government/collections/financial-sanctions-regime-specific-consolidated-lists-and-releases',
    description: 'UK OFSI — consolidated sanctions list releases',
  },
  // ── New Zealand ───────────────────────────────────────────────────────────
  {
    id: 'nz-immigration-updates',
    regulatorCode: 'nz-immigration',
    country: 'NZ',
    vertical: 'immigration',
    url: 'https://www.immigration.govt.nz/about-us/media-centre/news-notifications',
    description: 'NZ Immigration — news and notifications',
  },
  // ── Qatar ─────────────────────────────────────────────────────────────────
  {
    id: 'qcb-circulars',
    regulatorCode: 'qa-central-bank',
    country: 'QA',
    vertical: 'banking',
    url: 'https://www.qcb.gov.qa/en/Pages/Circulars.aspx',
    description: 'QCB — regulatory circulars',
  },
  // ── Bahrain ───────────────────────────────────────────────────────────────
  {
    id: 'cbb-regulations',
    regulatorCode: 'bh-central-bank',
    country: 'BH',
    vertical: 'banking',
    url: 'https://www.cbb.gov.bh/regulation/',
    description: 'CBB — regulatory rulebooks',
  },
  // ── OFAC / UN / EU (global sanctions lists) ──────────────────────────────
  {
    id: 'ofac-sanctions-list',
    regulatorCode: 'global',
    country: 'US',
    vertical: 'banking',
    url: 'https://www.treasury.gov/ofac/downloads/sdn.xml',
    description: 'OFAC — SDN list XML (change = new designations)',
  },
  {
    id: 'eu-sanctions-list',
    regulatorCode: 'global',
    country: 'EU',
    vertical: 'banking',
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content',
    description: 'EU — consolidated financial sanctions list XML',
  },
];

// ── RegulatoryRadarEngine ──────────────────────────────────────────────────

@Injectable()
export class RegulatoryRadarEngine {
  private readonly logger = new Logger(RegulatoryRadarEngine.name);

  // sourceId → SHA-256 of last-seen content
  private readonly hashCache = new Map<string, string>();

  // Ordered list of detected changes (newest last), capped at 500
  private readonly changeLog: RadarChange[] = [];

  private readonly radarEnabled: boolean;
  private readonly userAgent =
    'MeruRegOS/1.0 RegulatoryRadar (+https://api.meru.com/radar)';
  private readonly fetchTimeoutMs = 30_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.radarEnabled =
      configService.get<string>('REGULATORY_RADAR_ENABLED') !== 'false';

    if (this.radarEnabled) {
      this.logger.log(
        `Regulatory Radar armed — monitoring ${MONITORED_SOURCES.length} sources`,
      );
    } else {
      this.logger.warn(
        'Regulatory Radar DISABLED (REGULATORY_RADAR_ENABLED=false)',
      );
    }
  }

  // ── Scheduled scan (1 AM UTC daily) ──────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduledScan(): Promise<void> {
    if (!this.radarEnabled) return;
    await this.runScan();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async runScan(
    sourceFilter?: string[],
  ): Promise<RadarScanResult> {
    const sources = sourceFilter
      ? MONITORED_SOURCES.filter((s) => sourceFilter.includes(s.id))
      : MONITORED_SOURCES;

    const result: RadarScanResult = {
      scannedAt: new Date(),
      sourcesScanned: sources.length,
      changesDetected: 0,
      errors: 0,
      changes: [],
    };

    this.logger.log(`Radar scan started — ${sources.length} sources`);

    for (const source of sources) {
      try {
        const change = await this.checkSource(source);
        if (change) {
          result.changesDetected++;
          result.changes.push(change);
          this.changeLog.push(change);
          if (this.changeLog.length > 500) this.changeLog.shift();

          this.logger.warn(
            `RADAR CHANGE DETECTED: ${source.id} (${source.country}/${source.vertical})`,
          );

          this.eventEmitter.emit('radar.change.detected', change);
          await this.writeChangeProposal(change);
        }
      } catch (err: unknown) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Radar scan error for ${source.id}: ${msg}`);
      }
    }

    this.logger.log(
      `Radar scan complete — ${result.changesDetected} changes, ${result.errors} errors`,
    );

    this.eventEmitter.emit('radar.scan.complete', result);
    return result;
  }

  getChangeLog(
    filter?: { country?: string; vertical?: string; status?: RadarChange['status'] },
  ): RadarChange[] {
    let log = [...this.changeLog];
    if (filter?.country) log = log.filter((c) => c.country === filter.country);
    if (filter?.vertical) log = log.filter((c) => c.vertical === filter.vertical);
    if (filter?.status) log = log.filter((c) => c.status === filter.status);
    return log.reverse(); // newest first
  }

  acknowledgeChange(sourceId: string): boolean {
    const change = [...this.changeLog]
      .reverse()
      .find((c) => c.sourceId === sourceId && c.status === 'pending_review');
    if (!change) return false;
    change.status = 'acknowledged';
    return true;
  }

  getMonitoredSources(): RadarSource[] {
    return MONITORED_SOURCES;
  }

  // ── Core check logic ──────────────────────────────────────────────────────

  private async checkSource(source: RadarSource): Promise<RadarChange | null> {
    const content = await this.fetchWithTimeout(source.url);
    const currentHash = this.sha256(content);
    const previousHash = this.hashCache.get(source.id) ?? null;

    this.hashCache.set(source.id, currentHash);

    if (previousHash === null) {
      // First run — baseline established, no change to report
      return null;
    }

    if (previousHash === currentHash) {
      return null;
    }

    return {
      sourceId: source.id,
      regulatorCode: source.regulatorCode,
      country: source.country,
      vertical: source.vertical,
      url: source.url,
      description: source.description,
      previousHash,
      currentHash,
      detectedAt: new Date(),
      status: 'pending_review',
    };
  }

  private async fetchWithTimeout(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.fetchTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xml,text/xml,*/*',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  // Writes a JSON proposal file next to the relevant config pack directory.
  // Human reviewers (or Regulatory Radar PR automation) pick these up.
  private async writeChangeProposal(change: RadarChange): Promise<void> {
    try {
      const countryCode = change.country.toLowerCase();
      const baseDir = path.resolve(
        process.cwd(),
        'packages',
        'config-packs',
        countryCode,
      );

      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }

      const filename = `radar-${change.sourceId}-${Date.now()}.proposal.json`;
      const filePath = path.join(baseDir, filename);

      const proposal = {
        ...change,
        instructions:
          'Review source URL for regulatory changes and update the config pack JSON accordingly. Delete this file after applying.',
      };

      fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf8');
      change.proposedDiffPath = filePath;

      this.logger.log(`Change proposal written: ${filePath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write change proposal: ${msg}`);
    }
  }
}
