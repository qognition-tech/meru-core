import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Query,
  HttpException,
  HttpStatus,
  HttpCode,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { IntegrationsService } from './integrations.service';
import type {
  AdapterResponse,
  GovernmentAdapter,
} from './interfaces/government-adapter.interface';
import { ScreenEntityDto } from './dto/screen-entity.dto';
import { AddVesselDto, TradeInstrumentBodyDto } from './dto/vessel-trade.dto';
import { VesselService } from './services/vessel.service';
import { TradeService } from './services/trade.service';
import { ImportService } from './services/import.service';
import type { AuthenticatedRequest } from '../common/types';
import { AuHomeAffairsAdapter } from './adapters/au-home-affairs.adapter';
import { UaeCentralBankAdapter } from './adapters/uae-central-bank.adapter';
import { SaSamaAdapter } from './adapters/sa-sama.adapter';
import { QaCentralBankAdapter } from './adapters/qa-central-bank.adapter';
import { BhCentralBankAdapter } from './adapters/bh-central-bank.adapter';
import { CaIrccAdapter } from './adapters/ca-ircc.adapter';
import { UkHomeOfficeAdapter } from './adapters/uk-home-office.adapter';
import { NzImmigrationAdapter } from './adapters/nz-immigration.adapter';

@ApiTags('integrations')
@Controller('integrations')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly auAdapter: AuHomeAffairsAdapter,
    private readonly cbuaeAdapter: UaeCentralBankAdapter,
    private readonly samaAdapter: SaSamaAdapter,
    private readonly qcbAdapter: QaCentralBankAdapter,
    private readonly cbbAdapter: BhCentralBankAdapter,
    private readonly irccAdapter: CaIrccAdapter,
    private readonly ukviAdapter: UkHomeOfficeAdapter,
    private readonly inzAdapter: NzImmigrationAdapter,
    private readonly vesselService: VesselService,
    private readonly tradeService: TradeService,
    private readonly importService: ImportService,
  ) {}

  /**
   * Unwrap a government adapter's response, or fail the request.
   *
   * An unreachable or erroring upstream used to come back as **HTTP 200** with
   * a populated `error` and `data: null`. A client that reads `data` — which is
   * every client — then rendered an empty page with no indication anything had
   * gone wrong. A failed call is a gateway failure and gets a 5xx.
   *
   * `retryable` picks the code: 503 invites a retry, 502 does not.
   *
   * Every success now carries `provenance`, which answers the question the
   * frontend blocked on before wiring these 33 operations: *is this real
   * regulator data?* The flag was on `AdapterResponse` all along and this
   * method dropped it on the way out, so a sandbox visa status and a live one
   * were byte-identical over HTTP. That is the most dangerous shape this
   * product can ship — a compliance officer acts on a visa status — and the
   * alternative the frontend was left with, inferring it from configuration,
   * silently becomes wrong in the unsafe direction the moment one adapter goes
   * live.
   *
   * `provenance` is nested rather than merged as loose keys so it can never
   * collide with a regulator's own field named `sandbox` or `source`.
   */
  private static unwrap<T>(
    result: AdapterResponse<T>,
    adapter?: GovernmentAdapter,
  ): unknown {
    if (!result.success) {
      throw new HttpException(
        {
          code: result.error?.code ?? 'ADAPTER_ERROR',
          message:
            result.error?.message ?? 'The government adapter call failed',
          retryable: result.error?.retryable ?? false,
          requestId: result.requestId,
          sandbox: result.sandbox,
          adapterId: adapter?.adapterId,
          regulator: adapter?.regulatorName,
        },
        result.error?.retryable
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.BAD_GATEWAY,
      );
    }

    const provenance = {
      /** True when the payload came from a stub, not the regulator. */
      sandbox: result.sandbox,
      adapterId: adapter?.adapterId ?? null,
      regulator: adapter?.regulatorName ?? null,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      retrievedAt: new Date().toISOString(),
    };

    const data = result.data;

    // Merged for objects, wrapped for arrays and primitives. Splatting an
    // array would turn it into an index-keyed object and break every caller
    // that maps over it.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { ...(data as Record<string, unknown>), provenance };
    }

    return { data: data ?? null, provenance };
  }

  // ── Record import (Layer 4 `importMappings[]`) ────────────────────────────

  @Get('import/mappings')
  @ApiOperation({
    summary: "The import mappings the caller's vertical declares",
    description:
      'Field maps live in the config pack because the target fields are the ' +
      "vertical's own, and core does not know their names.",
  })
  async listImportMappings(@Request() req: AuthenticatedRequest) {
    return this.importService.listMappings(req.tenantVertical ?? null);
  }

  @Post('import/:mappingKey')
  @ApiOperation({
    summary: 'Plan an import — and only write if asked',
    description:
      'Parses the CSV, applies the mapping, and returns the diff: creates, ' +
      'updates, per-row errors, unmapped columns. **Nothing is written unless ' +
      '`commit=true`**, and the committed run acts on exactly the plan a ' +
      'reviewer approved. An import is the easiest way for a firm to destroy ' +
      'its own data, and the damage is usually noticed days later.',
  })
  @ApiParam({ name: 'mappingKey', description: 'Mapping key from the config pack' })
  @ApiQuery({
    name: 'commit',
    required: false,
    type: Boolean,
    description: 'Defaults to false — dry run',
  })
  @ApiResponse({ status: 400, description: 'Unknown mapping, empty file, or too many rows' })
  async runImport(
    @Request() req: AuthenticatedRequest,
    @Param('mappingKey') mappingKey: string,
    @Body() body: { csv: string },
    @Query('commit') commit?: string,
  ) {
    return this.importService.run(
      req.user.tenantId,
      req.tenantVertical ?? null,
      mappingKey,
      body?.csv ?? '',
      { commit: commit === 'true' },
    );
  }

  // ── Vessel tracking (CLAUDE.md §3.4) ──────────────────────────────────────
  //
  // A watched vessel is a `UniversalEntity` of type `asset`; positions and risk
  // are fetched live from the engine on every read, never cached, because a
  // stale AIS position is a wrong one.

  @Get('vessel')
  @ApiOperation({
    summary: 'This tenant’s vessel watchlist, with live position and risk',
    description:
      'Each vessel is enriched independently — one failed AIS lookup degrades ' +
      'that row to `live: false` rather than failing the page. `live: false` ' +
      'means the nulls are "unknown", not "no risk".',
  })
  async listVessels(@Request() req: AuthenticatedRequest) {
    return this.vesselService.listWatchlist(req.user.tenantId);
  }

  @Get('vessel/alerts')
  @ApiOperation({
    summary: 'Risk alerts across the watchlist, most severe first',
    description:
      'Derived from live risk scoring — sanctioned-port geofence breaches, ' +
      'AIS dark periods, flag risk.',
  })
  async listVesselAlerts(@Request() req: AuthenticatedRequest) {
    return this.vesselService.listAlerts(req.user.tenantId);
  }

  @Post('vessel/watchlist')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a vessel to the watchlist',
    description:
      'Idempotent on IMO/MMSI — re-adding a watched vessel returns the ' +
      'existing row rather than duplicating it into the alert feed.',
  })
  @ApiResponse({ status: 201, description: 'Vessel watched' })
  @ApiResponse({ status: 400, description: 'Neither IMO nor MMSI supplied' })
  async addVessel(
    @Request() req: AuthenticatedRequest,
    @Body() dto: AddVesselDto,
  ) {
    return this.vesselService.addToWatchlist(req.user.tenantId, dto);
  }

  @Delete('vessel/watchlist/:id')
  @ApiOperation({ summary: 'Stop watching a vessel' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Vessel removed' })
  @ApiResponse({ status: 404, description: 'Not on this tenant’s watchlist' })
  async removeVessel(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vesselService.removeFromWatchlist(req.user.tenantId, id);
  }

  // ── Trade finance ─────────────────────────────────────────────────────────
  //
  // Instruments are `UniversalEntity` rows, not a core trade table — banking
  // schema stays out of core (CLAUDE.md §11.3). What core contributes is the
  // horizontal part: counterparty screening via the Screening engine.

  @Get('trade')
  @ApiOperation({ summary: 'List trade finance instruments' })
  async listTrade(@Request() req: AuthenticatedRequest) {
    return this.tradeService.list(req.user.tenantId);
  }

  @Get('trade/:id')
  @ApiOperation({ summary: 'Get one trade finance instrument' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 404, description: 'Not found on this tenant' })
  async getTrade(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tradeService.get(req.user.tenantId, id);
  }

  @Post('trade')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Book a trade instrument, screening its counterparties',
    description:
      'Applicant and beneficiary are screened on write — an unscreened ' +
      'instrument is the thing a bank must not book. A screening failure is ' +
      'recorded as `screeningStatus: "ERROR"` for manual review rather than ' +
      'rejecting the write.',
  })
  @ApiResponse({ status: 201, description: 'Instrument booked' })
  async createTrade(
    @Request() req: AuthenticatedRequest,
    @Body() dto: TradeInstrumentBodyDto,
  ) {
    return this.tradeService.create(req.user.tenantId, dto);
  }

  @Patch('trade/:id')
  @ApiOperation({
    summary: 'Update a trade instrument',
    description:
      'Counterparty changes trigger a re-screen — carrying a clear result ' +
      'forward from a different name would be worse than not screening.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async updateTrade(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TradeInstrumentBodyDto,
  ) {
    return this.tradeService.update(req.user.tenantId, id, dto);
  }

  // PUT alias — separate handler, because stacking verb decorators on one
  // method registers only the last one.
  @Put('trade/:id')
  @ApiOperation({ summary: 'Update a trade instrument (alias of PATCH)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async replaceTrade(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TradeInstrumentBodyDto,
  ) {
    return this.tradeService.update(req.user.tenantId, id, dto);
  }

  @Get('adapters')
  @ApiOperation({ summary: 'List all registered government API adapters' })
  listAdapters() {
    return this.integrationsService.listAdapters();
  }

  @Get('adapters/health')
  @ApiOperation({ summary: 'Health check all registered adapters' })
  async healthCheckAll() {
    const results = await this.integrationsService.healthCheckAll();
    return results;
  }

  // ── AU HomeAffairs ────────────────────────────────────────────────────────

  @Get('au/visa-status/:visaNumber')
  @ApiOperation({ summary: 'AU — Check visa status via DHA' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async auVisaStatus(
    @Param('visaNumber') visaNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.auAdapter.getVisaStatus(
      visaNumber,
      passportNumber,
    );
    return IntegrationsController.unwrap(result, this.auAdapter);
  }

  @Get('au/application-status/:applicationId')
  @ApiOperation({ summary: 'AU — Check application status via DHA' })
  async auApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.auAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.unwrap(result, this.auAdapter);
  }

  @Get('au/sponsor-validation')
  @ApiOperation({ summary: 'AU — Validate employer sponsor licence via DHA' })
  @ApiQuery({ name: 'abn', required: true })
  async auSponsorValidation(@Query('abn') abn: string) {
    const result = await this.auAdapter.validateSponsor(abn);
    return IntegrationsController.unwrap(result, this.auAdapter);
  }

  @Post('au/vevo-check')
  @ApiOperation({ summary: 'AU — VEVO visa entitlement check' })
  async auVevoCheck(@Body() body: { visaNumber: string; dateOfBirth: string }) {
    const result = await this.auAdapter.vevoCheck(
      body.visaNumber,
      body.dateOfBirth,
    );
    return IntegrationsController.unwrap(result, this.auAdapter);
  }

  // ── UAE Central Bank ──────────────────────────────────────────────────────

  @Post('ae/screening')
  @ApiOperation({ summary: 'AE — Sanctions screening via CBUAE' })
  async aeScreening(@Body() body: ScreenEntityDto) {
    const result = await this.cbuaeAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.unwrap(result, this.cbuaeAdapter);
  }

  @Post('ae/str')
  @ApiOperation({
    summary: 'AE — File Suspicious Transaction Report via CBUAE',
  })
  async aeFileSTR(
    @Body()
    body: {
      reportingEntityId: string;
      subjectName: string;
      subjectIdNumber?: string;
      transactionDetails: string;
      suspicionReason: string;
      amount?: number;
      currency?: string;
      transactionDate?: string;
    },
  ) {
    const result = await this.cbuaeAdapter.fileSTR(body);
    return IntegrationsController.unwrap(result, this.cbuaeAdapter);
  }

  @Get('ae/regulatory-updates')
  @ApiOperation({ summary: 'AE — CBUAE regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async aeRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.cbuaeAdapter.getRegulatoryUpdates({
      category,
      since,
    });
    return IntegrationsController.unwrap(result, this.cbuaeAdapter);
  }

  @Get('ae/verify-entity/:licenseNumber')
  @ApiOperation({ summary: 'AE — Verify trade license via CBUAE' })
  async aeVerifyEntity(@Param('licenseNumber') licenseNumber: string) {
    const result = await this.cbuaeAdapter.verifyEntity(licenseNumber);
    return IntegrationsController.unwrap(result, this.cbuaeAdapter);
  }

  // ── Saudi SAMA ────────────────────────────────────────────────────────────

  @Post('sa/screening')
  @ApiOperation({ summary: 'SA — Sanctions screening via SAMA' })
  async saScreening(@Body() body: ScreenEntityDto) {
    const result = await this.samaAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.unwrap(result, this.samaAdapter);
  }

  @Post('sa/str')
  @ApiOperation({ summary: 'SA — File Suspicious Transaction Report via SAMA' })
  async saFileSTR(
    @Body()
    body: {
      reportingEntityId: string;
      subjectName: string;
      subjectIdNumber?: string;
      transactionDetails: string;
      suspicionReason: string;
      amount?: number;
      currency?: string;
      transactionDate?: string;
    },
  ) {
    const result = await this.samaAdapter.fileSTR(body);
    return IntegrationsController.unwrap(result, this.samaAdapter);
  }

  @Get('sa/regulatory-updates')
  @ApiOperation({ summary: 'SA — SAMA regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async saRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.samaAdapter.getRegulatoryUpdates({
      category,
      since,
    });
    return IntegrationsController.unwrap(result, this.samaAdapter);
  }

  @Get('sa/verify-entity/:crn')
  @ApiOperation({ summary: 'SA — Verify commercial registration via SAMA' })
  async saVerifyEntity(@Param('crn') crn: string) {
    const result = await this.samaAdapter.verifyEntity(crn);
    return IntegrationsController.unwrap(result, this.samaAdapter);
  }

  // ── Qatar QCB ─────────────────────────────────────────────────────────────

  @Post('qa/screening')
  @ApiOperation({ summary: 'QA — Sanctions screening via QCB' })
  async qaScreening(@Body() body: ScreenEntityDto) {
    const result = await this.qcbAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.unwrap(result, this.qcbAdapter);
  }

  @Post('qa/str')
  @ApiOperation({ summary: 'QA — File Suspicious Transaction Report via QCB' })
  async qaFileSTR(
    @Body()
    body: {
      reportingEntityId: string;
      subjectName: string;
      subjectIdNumber?: string;
      transactionDetails: string;
      suspicionReason: string;
      amount?: number;
      currency?: string;
      transactionDate?: string;
    },
  ) {
    const result = await this.qcbAdapter.fileSTR(body);
    return IntegrationsController.unwrap(result, this.qcbAdapter);
  }

  @Get('qa/regulatory-updates')
  @ApiOperation({ summary: 'QA — QCB regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async qaRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.qcbAdapter.getRegulatoryUpdates({
      category,
      since,
    });
    return IntegrationsController.unwrap(result, this.qcbAdapter);
  }

  @Get('qa/verify-entity/:crn')
  @ApiOperation({ summary: 'QA — Verify commercial registration via QCB' })
  async qaVerifyEntity(@Param('crn') crn: string) {
    const result = await this.qcbAdapter.verifyEntity(crn);
    return IntegrationsController.unwrap(result, this.qcbAdapter);
  }

  // ── Bahrain CBB ───────────────────────────────────────────────────────────

  @Post('bh/screening')
  @ApiOperation({ summary: 'BH — Sanctions screening via CBB' })
  async bhScreening(@Body() body: ScreenEntityDto) {
    const result = await this.cbbAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.unwrap(result, this.cbbAdapter);
  }

  @Post('bh/str')
  @ApiOperation({ summary: 'BH — File Suspicious Transaction Report via CBB' })
  async bhFileSTR(
    @Body()
    body: {
      reportingEntityId: string;
      subjectName: string;
      subjectIdNumber?: string;
      transactionDetails: string;
      suspicionReason: string;
      amount?: number;
      currency?: string;
      transactionDate?: string;
    },
  ) {
    const result = await this.cbbAdapter.fileSTR(body);
    return IntegrationsController.unwrap(result, this.cbbAdapter);
  }

  @Get('bh/regulatory-updates')
  @ApiOperation({ summary: 'BH — CBB regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async bhRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.cbbAdapter.getRegulatoryUpdates({
      category,
      since,
    });
    return IntegrationsController.unwrap(result, this.cbbAdapter);
  }

  @Get('bh/verify-entity/:crn')
  @ApiOperation({ summary: 'BH — Verify commercial registration via CBB' })
  async bhVerifyEntity(@Param('crn') crn: string) {
    const result = await this.cbbAdapter.verifyEntity(crn);
    return IntegrationsController.unwrap(result, this.cbbAdapter);
  }

  // ── Canada IRCC ───────────────────────────────────────────────────────────

  @Get('ca/visa-status/:documentNumber')
  @ApiOperation({ summary: 'CA — Check visa status via IRCC' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async caVisaStatus(
    @Param('documentNumber') documentNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.irccAdapter.getVisaStatus(
      documentNumber,
      passportNumber,
    );
    return IntegrationsController.unwrap(result, this.irccAdapter);
  }

  @Get('ca/application-status/:applicationId')
  @ApiOperation({ summary: 'CA — Check application status via IRCC' })
  async caApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.irccAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.unwrap(result, this.irccAdapter);
  }

  @Get('ca/employer-validation')
  @ApiOperation({ summary: 'CA — Validate employer via IRCC' })
  @ApiQuery({ name: 'businessNumber', required: true })
  async caEmployerValidation(@Query('businessNumber') businessNumber: string) {
    const result = await this.irccAdapter.validateEmployer(businessNumber);
    return IntegrationsController.unwrap(result, this.irccAdapter);
  }

  // ── UK Home Office / UKVI ─────────────────────────────────────────────────

  @Get('uk/visa-status/:visaReference')
  @ApiOperation({ summary: 'UK — Check visa status via UKVI' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async ukVisaStatus(
    @Param('visaReference') visaReference: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.ukviAdapter.getVisaStatus(
      visaReference,
      passportNumber,
    );
    return IntegrationsController.unwrap(result, this.ukviAdapter);
  }

  @Get('uk/application-status/:applicationId')
  @ApiOperation({ summary: 'UK — Check application status via UKVI' })
  async ukApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.ukviAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.unwrap(result, this.ukviAdapter);
  }

  @Get('uk/sponsor-validation/:licenceNumber')
  @ApiOperation({ summary: 'UK — Validate sponsor licence via UKVI' })
  async ukSponsorValidation(@Param('licenceNumber') licenceNumber: string) {
    const result = await this.ukviAdapter.validateSponsor(licenceNumber);
    return IntegrationsController.unwrap(result, this.ukviAdapter);
  }

  @Post('uk/right-to-work')
  @ApiOperation({ summary: 'UK — Right to Work check via UKVI' })
  async ukRightToWork(
    @Body() body: { shareCode: string; dateOfBirth: string },
  ) {
    const result = await this.ukviAdapter.rightToWorkCheck(
      body.shareCode,
      body.dateOfBirth,
    );
    return IntegrationsController.unwrap(result, this.ukviAdapter);
  }

  // ── New Zealand INZ ───────────────────────────────────────────────────────

  @Get('nz/visa-status/:visaNumber')
  @ApiOperation({ summary: 'NZ — Check visa status via INZ' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async nzVisaStatus(
    @Param('visaNumber') visaNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.inzAdapter.getVisaStatus(
      visaNumber,
      passportNumber,
    );
    return IntegrationsController.unwrap(result, this.inzAdapter);
  }

  @Get('nz/application-status/:applicationId')
  @ApiOperation({ summary: 'NZ — Check application status via INZ' })
  async nzApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.inzAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.unwrap(result, this.inzAdapter);
  }

  @Get('nz/employer-validation')
  @ApiOperation({ summary: 'NZ — Validate employer via INZ' })
  @ApiQuery({ name: 'nzbn', required: true })
  async nzEmployerValidation(@Query('nzbn') nzbn: string) {
    const result = await this.inzAdapter.validateEmployer(nzbn);
    return IntegrationsController.unwrap(result, this.inzAdapter);
  }

  @Post('nz/visa-view')
  @ApiOperation({ summary: 'NZ — VisaView entitlement check via INZ' })
  async nzVisaView(@Body() body: { visaNumber: string; dateOfBirth: string }) {
    const result = await this.inzAdapter.visaViewCheck(
      body.visaNumber,
      body.dateOfBirth,
    );
    return IntegrationsController.unwrap(result, this.inzAdapter);
  }
}
