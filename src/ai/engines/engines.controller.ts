import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { ScreeningEngine } from './screening.engine';
import { DocIntelEngine } from './doc-intel.engine';
import { VesselTrackingEngine } from './vessel-tracking.engine';
import { RegulatoryRadarEngine } from './regulatory-radar.engine';
import { RescreeningService } from './rescreening.service';
import { ScoringEngine } from './scoring.engine';
import { WatchlistIngestService } from './watchlist-ingest.service';
import {
  ScreenRequestDto,
  DocIntelRequestDto,
  VesselRiskRequestDto,
  ScoreRequestDto,
} from './dto/engine-requests.dto';
import type { AuthenticatedRequest } from '../../common/types';

/**
 * The four specialist engines, exposed once for every vertical.
 *
 * CLAUDE.md §3 says each engine is "consumed by all verticals", but until now
 * none of them had a vertical-neutral route: screening was reachable only
 * through country-specific adapter endpoints (`/integrations/ae/screening`)
 * and GovernanceX's trade service, doc-intel only from inside the document
 * pipeline, and radar only from the scheduler. ImmiStack could not screen a
 * visa applicant or fraud-check a passport scan at all, despite the docs
 * promising exactly that.
 *
 * These routes are the shared surface. They are vertical-neutral by
 * construction — an engine receives a name, a document or a vessel, never a
 * "case" or an "obligation" — so adding a vertical needs no change here.
 *
 * Note the distinction from `/integrations/{country}/screening`: those call a
 * *regulator's* screening service through a country adapter. This calls
 * Meru's own Screening Engine against ingested sanctions lists. Both exist on
 * purpose and answer different questions.
 */
@Controller('engines')
@ApiTags('engines')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class EnginesController {
  constructor(
    private readonly screening: ScreeningEngine,
    private readonly docIntel: DocIntelEngine,
    private readonly vessel: VesselTrackingEngine,
    private readonly radar: RegulatoryRadarEngine,
    private readonly watchlist: WatchlistIngestService,
    private readonly rescreening: RescreeningService,
    private readonly scoring: ScoringEngine,
  ) {}

  // ── Screening ─────────────────────────────────────────────────────────────

  @Post('screening')
  @ApiOperation({
    summary: 'Screen a name against sanctions / PEP / adverse-media lists',
    description:
      'Vertical-neutral: GovernanceX screens counterparties, ImmiStack ' +
      'screens visa applicants, and both call this. Matching runs in-process ' +
      'against ingested lists (OFAC SDN, UN, EU CFSP, UK OFSI) plus any ' +
      'customWatchlist supplied on the request. When no list is ingested ' +
      '(watchlist_entries empty) this answers 503 with listsLoaded:false and ' +
      'unavailableReason — it never returns a "clear" computed over nothing.',
  })
  @ApiResponse({
    status: 201,
    description: 'Screening result with hits; listsLoaded is always true here',
  })
  @ApiResponse({
    status: 503,
    description:
      'No sanctions lists loaded, or they could not be read. Body carries ' +
      'listsLoaded:false + unavailableReason. Run POST /jobs/watchlist-ingest.',
  })
  async screen(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ScreenRequestDto,
  ) {
    const request = {
      ...dto,
      // Never trust a tenantId from the body — it is the caller's identity,
      // not their input.
      tenantId: req.user.tenantId,
    };

    const result = await this.screening.screen(request, dto.threshold ?? 0.85);

    // Recorded so the rescreen sweep can revisit it. Awaited rather than
    // fire-and-forget: on a serverless runtime the invocation may be frozen
    // the moment the response is written, and a detached promise would be
    // lost — leaving a screening that is never rescreened, which is exactly
    // the failure this record exists to prevent. `record` never throws.
    await this.rescreening.record(req.user.tenantId, request, result);

    return result;
  }

  @Get('screening/watchlist-status')
  @ApiOperation({
    summary: 'How many sanctions entries are loaded',
    description:
      'Zero means screening is running on built-in samples only and cannot ' +
      'produce a true positive against a real name — surface that in the UI ' +
      'rather than implying a clean screen.',
  })
  async watchlistStatus() {
    const { entries, lists } = await this.watchlist.inventory();

    // A list nobody has re-confirmed in a fortnight is a feed that has stopped
    // working, not a quiet week at OFAC. Named per list so the UI can mark the
    // stale one rather than discrediting the whole screen.
    const stale = lists.filter((l) => (l.staleDays ?? 999) > 14);

    return {
      entries,
      ingested: entries > 0,
      /** Which lists are actually loaded — render this, do not hardcode it. */
      lists,
      warning:
        entries === 0
          ? 'No sanctions lists ingested. Run the watchlist-ingest job.'
          : stale.length > 0
            ? `Stale feeds: ${stale.map((l) => `${l.source} (${l.staleDays ?? '?'}d)`).join(', ')}`
            : null,
    };
  }

  // ── Document Intelligence ─────────────────────────────────────────────────

  @Post('doc-intel')
  @ApiOperation({
    summary: 'Extract structured data and fraud signals from a document',
    description:
      'Immigration passports and payslips, banking trade documents — same ' +
      'engine. Returns extracted fields with per-field confidence plus ' +
      'tampering / EXIF / duplicate signals. A heuristic fallback caps ' +
      'confidence at 0.45 to force human review when no vision model is ' +
      'configured; check `modelUsed` before trusting an extraction.',
  })
  @ApiResponse({ status: 201, description: 'Extraction + fraud assessment' })
  async processDocument(
    @Request() req: AuthenticatedRequest,
    @Body() dto: DocIntelRequestDto,
  ) {
    return this.docIntel.process({
      ...dto,
      tenantId: req.user.tenantId,
      fileBuffer: dto.base64Image
        ? Buffer.from(dto.base64Image, 'base64')
        : undefined,
    });
  }

  // ── Vessel / Asset Tracking ───────────────────────────────────────────────

  @Post('vessel/risk')
  @ApiOperation({
    summary: 'Assess vessel risk (dark periods, sanctioned-port calls)',
    description:
      'riskScore/riskLevel are null when no AIS source is available — that ' +
      'means UNKNOWN, never clear. Check `live` and `unavailableReason` ' +
      'before rendering any all-clear indicator.',
  })
  @ApiResponse({ status: 201, description: 'Vessel risk assessment' })
  async vesselRisk(@Body() dto: VesselRiskRequestDto) {
    return this.vessel.assessVesselRisk(dto);
  }

  @Get('vessel/lookup')
  @ApiOperation({ summary: 'Look up a vessel by MMSI, IMO or name' })
  @ApiQuery({ name: 'mmsi', required: false })
  @ApiQuery({ name: 'imo', required: false })
  @ApiQuery({ name: 'vesselName', required: false })
  async vesselLookup(
    @Query('mmsi') mmsi?: string,
    @Query('imo') imo?: string,
    @Query('vesselName') vesselName?: string,
  ) {
    return this.vessel.lookupVessel({ mmsi, imo, vesselName });
  }

  // ── Regulatory Radar ──────────────────────────────────────────────────────

  @Post('radar/scan')
  @ApiOperation({
    summary: 'Run a regulatory-source scan now',
    description:
      'Normally scheduled. Detected changes are returned as pending_review — ' +
      'nothing is auto-applied to a tenant, per the human-in-the-loop rule ' +
      'in CLAUDE.md §3.1.',
  })
  @ApiQuery({
    name: 'sources',
    required: false,
    description: 'Comma-separated source ids to limit the scan',
  })
  async radarScan(@Query('sources') sources?: string) {
    return this.radar.runScan(
      sources ? sources.split(',').map((s) => s.trim()) : undefined,
    );
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  @Get('scoring')
  @ApiOperation({
    summary: "List the scoring models the caller's vertical defines",
    description:
      'Lead scoring, visa recommendation and risk scoring are all weighted ' +
      'sums authored in the config pack, so the available models depend on ' +
      'the pack rather than on this API. An empty list means the pack ' +
      'defines none — not that scoring is unavailable.',
  })
  async listScoringModels(@Request() req: AuthenticatedRequest) {
    return this.scoring.list(req.tenantVertical ?? null);
  }

  @Post('scoring/:modelKey')
  @ApiOperation({
    summary: 'Score a record against a pack-defined model',
    description:
      'Returns the score, the band it falls in, and every factor with ' +
      'whether it matched. The contributions are part of the contract: a ' +
      'score nobody can explain is a score nobody will act on.',
  })
  @ApiParam({ name: 'modelKey', example: 'lead_score' })
  @ApiResponse({ status: 201, description: 'Score, band and contributions' })
  async score(
    @Request() req: AuthenticatedRequest,
    @Param('modelKey') modelKey: string,
    @Body() dto: ScoreRequestDto,
  ) {
    // The vertical selects the model, exactly as it selects the prompt
    // library: PolicyGuard has already resolved it from the tenant.
    return this.scoring.score(req.tenantVertical ?? null, modelKey, dto.data);
  }
}
