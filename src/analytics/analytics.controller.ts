import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './analytics.service';
import { PackDashboardService } from './pack-dashboard.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { CreateReportDto, CreateWidgetDto } from './dto/analytics.dto';
import type { DashboardWidget } from './entities/dashboard-widget.entity';
import type { AuthenticatedRequest } from '../common/types';
import {
  PackUiService,
  type Portal,
} from '../tenant/services/pack-ui.service';

const PORTALS: Portal[] = ['admin', 'staff', 'client', 'platform'];

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class AnalyticsController {
  constructor(
    private analyticsService: AnalyticsService,
    private readonly packDashboards: PackDashboardService,
    private readonly packUi: PackUiService,
  ) {}

  // ==================== REPORTS ====================

  @Post('reports')
  @ApiOperation({ summary: 'Create a new report' })
  async createReport(@Request() req, @Body() dto: CreateReportDto) {
    const report = await this.analyticsService.createReport(
      req.user.tenantId,
      req.user.id,
      dto,
    );
    return report;
  }

  @Get('reports')
  @ApiOperation({ summary: 'Get all reports' })
  @ApiQuery({ name: 'dataSource', required: false })
  async getReports(@Request() req, @Query('dataSource') dataSource?: string) {
    const reports = await this.analyticsService.getReports(
      req.user.tenantId,
      dataSource as any,
    );
    return reports;
  }

  // Must precede `reports/:id`. Nest matches in declaration order, so this
  // literal path was previously swallowed by the parameterised one and ran as
  // `getReport('generated')` — a 500 from Postgres
  // (`invalid input syntax for type uuid: "generated"`) rather than a result.
  @Get('reports/generated')
  @ApiOperation({
    summary: 'List past report runs, newest first',
    description:
      'Execution history for this tenant. Excludes each run’s stored result ' +
      'payload — request the report itself for that.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiResponse({ status: 200, description: 'Generated reports retrieved' })
  async getGeneratedReports(@Request() req, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.analyticsService.getGeneratedReports(
      req.user.tenantId,
      Number.isNaN(parsed) ? undefined : parsed,
    );
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Get report by ID' })
  async getReport(@Request() req, @Param('id') id: string) {
    return this.analyticsService.getReport(id, req.user.tenantId);
  }

  @Post('reports/:id/execute')
  @ApiOperation({ summary: 'Execute a report' })
  async executeReport(
    @Request() req,
    @Param('id') id: string,
    @Body() body: { parameters?: Record<string, any>; format?: string },
  ) {
    const result = await this.analyticsService.executeReport(
      req.user.tenantId,
      req.user.id,
      {
        reportId: id,
        parameters: body.parameters,
        format: body.format as any,
      },
    );
    return result;
  }

  // ==================== PACK-DRIVEN DASHBOARDS ====================
  //
  // Distinct from the `widgets` CRUD below, which is a tenant's own saved
  // widgets. These are the vertical's dashboards, declared in the config pack
  // and resolved against the caller's data — nothing here is stored per tenant.

  @Get('dashboards')
  @ApiOperation({
    summary: "List the dashboards the caller's config pack defines",
    description:
      'Definitions only, filtered to the caller by portal, role and ' +
      'entitlement. An empty array means the pack declares none — not that ' +
      'dashboards are unavailable.',
  })
  @ApiQuery({ name: 'portal', required: false, enum: PORTALS })
  async listPackDashboards(
    @Request() req: AuthenticatedRequest,
    @Query('portal') portal?: Portal,
  ) {
    const audience = await this.packUi.audienceFor(
      req.user.tenantId,
      req.user.roles ?? [],
      portal ?? null,
    );
    return this.packDashboards.list(req.tenantVertical ?? null, audience);
  }

  @Get('dashboards/:key')
  @ApiOperation({
    summary: 'Resolve one pack dashboard against the tenant data',
    description:
      'Every widget carries `value`, and a null `value` carries an ' +
      '`unavailableReason`. A widget whose scan hit its cap reports ' +
      '`truncated: true`, and its count is a lower bound.',
  })
  @ApiParam({ name: 'key', description: 'Dashboard key from the config pack' })
  @ApiResponse({ status: 404, description: 'No such dashboard for this caller' })
  async getPackDashboard(
    @Request() req: AuthenticatedRequest,
    @Param('key') key: string,
  ) {
    const audience = await this.packUi.audienceFor(
      req.user.tenantId,
      req.user.roles ?? [],
      null,
    );
    return this.packDashboards.resolve(
      req.user.tenantId,
      req.tenantVertical ?? null,
      key,
      audience,
    );
  }

  // ==================== WIDGETS ====================

  @Post('widgets')
  @ApiOperation({ summary: 'Create a dashboard widget' })
  async createWidget(@Request() req, @Body() dto: CreateWidgetDto) {
    // The DTO guarantees name and widgetType. `configuration` is the widget's
    // query/display definition — supplied by a dashboard or a config pack, not
    // a fixed core schema — so it is validated as an object here and
    // interpreted by the widget executor.
    const widget = await this.analyticsService.createWidget(
      req.user.tenantId,
      dto as Partial<DashboardWidget>,
    );
    return widget;
  }

  @Get('widgets')
  @ApiOperation({ summary: 'Get all dashboard widgets' })
  async getWidgets(@Request() req) {
    const widgets = await this.analyticsService.getWidgets(req.user.tenantId);
    return widgets;
  }

  @Get('widgets/:id/execute')
  @ApiOperation({ summary: 'Execute widget query' })
  async executeWidget(@Request() req, @Param('id') id: string) {
    const result = await this.analyticsService.executeWidget(
      req.user.tenantId,
      id,
    );
    return result;
  }

  // ==================== EXPORT ====================

  @Post('reports/:id/export')
  @ApiOperation({ summary: 'Export report to file' })
  async exportReport(
    @Request() req,
    @Param('id') id: string,
    @Body() body: { format: 'csv' | 'xlsx' | 'pdf' },
  ) {
    const result = await this.analyticsService.exportReport(
      req.user.tenantId,
      id,
      body.format,
    );
    return result;
  }
}
