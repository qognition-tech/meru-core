import { Controller, Get, Post, Param, Body, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { IntegrationsService } from './integrations.service';
import { AuHomeAffairsAdapter } from './adapters/au-home-affairs.adapter';
import { UaeCentralBankAdapter } from './adapters/uae-central-bank.adapter';

@ApiTags('integrations')
@Controller('integrations')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly auAdapter: AuHomeAffairsAdapter,
    private readonly cbuaeAdapter: UaeCentralBankAdapter,
  ) {}

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
}
