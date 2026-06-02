import { Controller, Get, Post, Param, Body, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { IntegrationsService } from './integrations.service';
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
  ) {}

  private static envelope(result: {
    success: boolean;
    data?: unknown;
    sandbox: boolean;
    latencyMs: number;
    requestId: string;
    error?: unknown;
  }) {
    return {
      success: result.success,
      data: result.data,
      meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId },
      error: result.error,
    };
  }

  @Get('adapters')
  @ApiOperation({ summary: 'List all registered government API adapters' })
  listAdapters() {
    return { success: true, data: this.integrationsService.listAdapters() };
  }

  @Get('adapters/health')
  @ApiOperation({ summary: 'Health check all registered adapters' })
  async healthCheckAll() {
    const results = await this.integrationsService.healthCheckAll();
    return { success: true, data: results };
  }

  // ── AU HomeAffairs ────────────────────────────────────────────────────────

  @Get('au/visa-status/:visaNumber')
  @ApiOperation({ summary: 'AU — Check visa status via DHA' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async auVisaStatus(
    @Param('visaNumber') visaNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.auAdapter.getVisaStatus(visaNumber, passportNumber);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Get('au/application-status/:applicationId')
  @ApiOperation({ summary: 'AU — Check application status via DHA' })
  async auApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.auAdapter.getApplicationStatus(applicationId);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Get('au/sponsor-validation')
  @ApiOperation({ summary: 'AU — Validate employer sponsor licence via DHA' })
  @ApiQuery({ name: 'abn', required: true })
  async auSponsorValidation(@Query('abn') abn: string) {
    const result = await this.auAdapter.validateSponsor(abn);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Post('au/vevo-check')
  @ApiOperation({ summary: 'AU — VEVO visa entitlement check' })
  async auVevoCheck(@Body() body: { visaNumber: string; dateOfBirth: string }) {
    const result = await this.auAdapter.vevoCheck(body.visaNumber, body.dateOfBirth);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  // ── UAE Central Bank ──────────────────────────────────────────────────────

  @Post('ae/screening')
  @ApiOperation({ summary: 'AE — Sanctions screening via CBUAE' })
  async aeScreening(@Body() body: { entityName: string; nationality?: string; idNumber?: string }) {
    const result = await this.cbuaeAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Post('ae/str')
  @ApiOperation({ summary: 'AE — File Suspicious Transaction Report via CBUAE' })
  async aeFileSTR(@Body() body: {
    reportingEntityId: string;
    subjectName: string;
    subjectIdNumber?: string;
    transactionDetails: string;
    suspicionReason: string;
    amount?: number;
    currency?: string;
    transactionDate?: string;
  }) {
    const result = await this.cbuaeAdapter.fileSTR(body);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Get('ae/regulatory-updates')
  @ApiOperation({ summary: 'AE — CBUAE regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async aeRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.cbuaeAdapter.getRegulatoryUpdates({ category, since });
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  @Get('ae/verify-entity/:licenseNumber')
  @ApiOperation({ summary: 'AE — Verify trade license via CBUAE' })
  async aeVerifyEntity(@Param('licenseNumber') licenseNumber: string) {
    const result = await this.cbuaeAdapter.verifyEntity(licenseNumber);
    return { success: result.success, data: result.data, meta: { sandbox: result.sandbox, latencyMs: result.latencyMs, requestId: result.requestId }, error: result.error };
  }

  // ── Saudi SAMA ────────────────────────────────────────────────────────────

  @Post('sa/screening')
  @ApiOperation({ summary: 'SA — Sanctions screening via SAMA' })
  async saScreening(@Body() body: { entityName: string; nationality?: string; idNumber?: string }) {
    const result = await this.samaAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.envelope(result);
  }

  @Post('sa/str')
  @ApiOperation({ summary: 'SA — File Suspicious Transaction Report via SAMA' })
  async saFileSTR(@Body() body: {
    reportingEntityId: string;
    subjectName: string;
    subjectIdNumber?: string;
    transactionDetails: string;
    suspicionReason: string;
    amount?: number;
    currency?: string;
    transactionDate?: string;
  }) {
    const result = await this.samaAdapter.fileSTR(body);
    return IntegrationsController.envelope(result);
  }

  @Get('sa/regulatory-updates')
  @ApiOperation({ summary: 'SA — SAMA regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async saRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.samaAdapter.getRegulatoryUpdates({ category, since });
    return IntegrationsController.envelope(result);
  }

  @Get('sa/verify-entity/:crn')
  @ApiOperation({ summary: 'SA — Verify commercial registration via SAMA' })
  async saVerifyEntity(@Param('crn') crn: string) {
    const result = await this.samaAdapter.verifyEntity(crn);
    return IntegrationsController.envelope(result);
  }

  // ── Qatar QCB ─────────────────────────────────────────────────────────────

  @Post('qa/screening')
  @ApiOperation({ summary: 'QA — Sanctions screening via QCB' })
  async qaScreening(@Body() body: { entityName: string; nationality?: string; idNumber?: string }) {
    const result = await this.qcbAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.envelope(result);
  }

  @Post('qa/str')
  @ApiOperation({ summary: 'QA — File Suspicious Transaction Report via QCB' })
  async qaFileSTR(@Body() body: {
    reportingEntityId: string;
    subjectName: string;
    subjectIdNumber?: string;
    transactionDetails: string;
    suspicionReason: string;
    amount?: number;
    currency?: string;
    transactionDate?: string;
  }) {
    const result = await this.qcbAdapter.fileSTR(body);
    return IntegrationsController.envelope(result);
  }

  @Get('qa/regulatory-updates')
  @ApiOperation({ summary: 'QA — QCB regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async qaRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.qcbAdapter.getRegulatoryUpdates({ category, since });
    return IntegrationsController.envelope(result);
  }

  @Get('qa/verify-entity/:crn')
  @ApiOperation({ summary: 'QA — Verify commercial registration via QCB' })
  async qaVerifyEntity(@Param('crn') crn: string) {
    const result = await this.qcbAdapter.verifyEntity(crn);
    return IntegrationsController.envelope(result);
  }

  // ── Bahrain CBB ───────────────────────────────────────────────────────────

  @Post('bh/screening')
  @ApiOperation({ summary: 'BH — Sanctions screening via CBB' })
  async bhScreening(@Body() body: { entityName: string; nationality?: string; idNumber?: string }) {
    const result = await this.cbbAdapter.screenEntity(body.entityName, {
      nationality: body.nationality,
      idNumber: body.idNumber,
    });
    return IntegrationsController.envelope(result);
  }

  @Post('bh/str')
  @ApiOperation({ summary: 'BH — File Suspicious Transaction Report via CBB' })
  async bhFileSTR(@Body() body: {
    reportingEntityId: string;
    subjectName: string;
    subjectIdNumber?: string;
    transactionDetails: string;
    suspicionReason: string;
    amount?: number;
    currency?: string;
    transactionDate?: string;
  }) {
    const result = await this.cbbAdapter.fileSTR(body);
    return IntegrationsController.envelope(result);
  }

  @Get('bh/regulatory-updates')
  @ApiOperation({ summary: 'BH — CBB regulatory circulars and updates' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'since', required: false })
  async bhRegulatoryUpdates(
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const result = await this.cbbAdapter.getRegulatoryUpdates({ category, since });
    return IntegrationsController.envelope(result);
  }

  @Get('bh/verify-entity/:crn')
  @ApiOperation({ summary: 'BH — Verify commercial registration via CBB' })
  async bhVerifyEntity(@Param('crn') crn: string) {
    const result = await this.cbbAdapter.verifyEntity(crn);
    return IntegrationsController.envelope(result);
  }

  // ── Canada IRCC ───────────────────────────────────────────────────────────

  @Get('ca/visa-status/:documentNumber')
  @ApiOperation({ summary: 'CA — Check visa status via IRCC' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async caVisaStatus(
    @Param('documentNumber') documentNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.irccAdapter.getVisaStatus(documentNumber, passportNumber);
    return IntegrationsController.envelope(result);
  }

  @Get('ca/application-status/:applicationId')
  @ApiOperation({ summary: 'CA — Check application status via IRCC' })
  async caApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.irccAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.envelope(result);
  }

  @Get('ca/employer-validation')
  @ApiOperation({ summary: 'CA — Validate employer via IRCC' })
  @ApiQuery({ name: 'businessNumber', required: true })
  async caEmployerValidation(@Query('businessNumber') businessNumber: string) {
    const result = await this.irccAdapter.validateEmployer(businessNumber);
    return IntegrationsController.envelope(result);
  }

  // ── UK Home Office / UKVI ─────────────────────────────────────────────────

  @Get('uk/visa-status/:visaReference')
  @ApiOperation({ summary: 'UK — Check visa status via UKVI' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async ukVisaStatus(
    @Param('visaReference') visaReference: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.ukviAdapter.getVisaStatus(visaReference, passportNumber);
    return IntegrationsController.envelope(result);
  }

  @Get('uk/application-status/:applicationId')
  @ApiOperation({ summary: 'UK — Check application status via UKVI' })
  async ukApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.ukviAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.envelope(result);
  }

  @Get('uk/sponsor-validation/:licenceNumber')
  @ApiOperation({ summary: 'UK — Validate sponsor licence via UKVI' })
  async ukSponsorValidation(@Param('licenceNumber') licenceNumber: string) {
    const result = await this.ukviAdapter.validateSponsor(licenceNumber);
    return IntegrationsController.envelope(result);
  }

  @Post('uk/right-to-work')
  @ApiOperation({ summary: 'UK — Right to Work check via UKVI' })
  async ukRightToWork(@Body() body: { shareCode: string; dateOfBirth: string }) {
    const result = await this.ukviAdapter.rightToWorkCheck(body.shareCode, body.dateOfBirth);
    return IntegrationsController.envelope(result);
  }

  // ── New Zealand INZ ───────────────────────────────────────────────────────

  @Get('nz/visa-status/:visaNumber')
  @ApiOperation({ summary: 'NZ — Check visa status via INZ' })
  @ApiQuery({ name: 'passportNumber', required: true })
  async nzVisaStatus(
    @Param('visaNumber') visaNumber: string,
    @Query('passportNumber') passportNumber: string,
  ) {
    const result = await this.inzAdapter.getVisaStatus(visaNumber, passportNumber);
    return IntegrationsController.envelope(result);
  }

  @Get('nz/application-status/:applicationId')
  @ApiOperation({ summary: 'NZ — Check application status via INZ' })
  async nzApplicationStatus(@Param('applicationId') applicationId: string) {
    const result = await this.inzAdapter.getApplicationStatus(applicationId);
    return IntegrationsController.envelope(result);
  }

  @Get('nz/employer-validation')
  @ApiOperation({ summary: 'NZ — Validate employer via INZ' })
  @ApiQuery({ name: 'nzbn', required: true })
  async nzEmployerValidation(@Query('nzbn') nzbn: string) {
    const result = await this.inzAdapter.validateEmployer(nzbn);
    return IntegrationsController.envelope(result);
  }

  @Post('nz/visa-view')
  @ApiOperation({ summary: 'NZ — VisaView entitlement check via INZ' })
  async nzVisaView(@Body() body: { visaNumber: string; dateOfBirth: string }) {
    const result = await this.inzAdapter.visaViewCheck(body.visaNumber, body.dateOfBirth);
    return IntegrationsController.envelope(result);
  }
}
