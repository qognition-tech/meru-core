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
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './analytics.service';
import { PolicyGuard } from '../iam/guards/policy.guard';

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  // ==================== REPORTS ====================

  @Post('reports')
  @ApiOperation({ summary: 'Create a new report' })
  async createReport(@Request() req, @Body() dto: any) {
    const report = await this.analyticsService.createReport(
      req.user.tenantId,
      req.user.id,
      dto,
    );
    return { success: true, data: report };
  }

  @Get('reports')
  @ApiOperation({ summary: 'Get all reports' })
  @ApiQuery({ name: 'dataSource', required: false })
  async getReports(@Request() req, @Query('dataSource') dataSource?: string) {
    const reports = await this.analyticsService.getReports(
      req.user.tenantId,
      dataSource as any,
    );
    return { success: true, data: reports };
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Get report by ID' })
  async getReport(@Request() req, @Param('id') id: string) {
    const report = await this.analyticsService.getReport(id, req.user.tenantId);
    return { success: true, data: report };
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

  // ==================== WIDGETS ====================

  @Post('widgets')
  @ApiOperation({ summary: 'Create a dashboard widget' })
  async createWidget(@Request() req, @Body() dto: any) {
    const widget = await this.analyticsService.createWidget(
      req.user.tenantId,
      dto,
    );
    return { success: true, data: widget };
  }

  @Get('widgets')
  @ApiOperation({ summary: 'Get all dashboard widgets' })
  async getWidgets(@Request() req) {
    const widgets = await this.analyticsService.getWidgets(req.user.tenantId);
    return { success: true, data: widgets };
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
    return { success: true, data: result };
  }
}
