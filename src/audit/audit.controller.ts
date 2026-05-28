import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from './audit.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import type { Response } from 'express';

@ApiTags('audit')
@Controller('audit')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Query audit logs' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async queryLogs(@Request() req, @Query() query: any) {
    const result = await this.auditService.queryLogs({
      tenantId: req.user.tenantId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      userId: query.userId,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      severity: query.severity,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });
    return { success: true, data: result.logs, meta: { total: result.total } };
  }

  @Get('logs/entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get entity audit history' })
  async getEntityHistory(
    @Request() req,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    const logs = await this.auditService.getEntityHistory(
      req.user.tenantId,
      entityType,
      entityId,
    );
    return { success: true, data: logs };
  }

  @Get('logs/user/:userId')
  @ApiOperation({ summary: 'Get user activity' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getUserActivity(
    @Request() req,
    @Param('userId') userId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    const logs = await this.auditService.getUserActivity(
      req.user.tenantId,
      userId,
      new Date(startDate),
      new Date(endDate),
    );
    return { success: true, data: logs };
  }

  @Post('logs/verify')
  @ApiOperation({ summary: 'Verify per-row checksums for all tenant logs' })
  async verifyIntegrity(@Request() req) {
    const result = await this.auditService.verifyTenantLogs(req.user.tenantId);
    return { success: true, data: result };
  }

  @Get('logs/verify-chain')
  @ApiOperation({
    summary: 'Verify tamper-evident hash chain for this tenant',
    description:
      'Walks every audit log in chronological order and verifies the SHA-256 chain is intact. Returns status=tampered if any log was modified or deleted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Chain verification result',
    schema: {
      example: {
        success: true,
        data: {
          status: 'valid',
          total: 142,
          valid: 142,
          details: 'Chain intact (142 logs verified)',
        },
      },
    },
  })
  async verifyChain(@Request() req) {
    const result = await this.auditService.verifyChain(req.user.tenantId);
    return { success: result.status === 'valid', data: result };
  }

  @Post('logs/export')
  @ApiOperation({ summary: 'Export audit logs' })
  async exportLogs(
    @Request() req,
    @Body()
    body: {
      startDate: string;
      endDate: string;
      format: 'json' | 'csv' | 'xml';
    },
    @Res() res: Response,
  ) {
    const { data, filename } = await this.auditService.exportLogs(
      req.user.tenantId,
      new Date(body.startDate),
      new Date(body.endDate),
      body.format,
    );

    res.setHeader(
      'Content-Type',
      body.format === 'json' ? 'application/json' : 'text/plain',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data);
  }

  @Get('compliance/:standard')
  @ApiOperation({ summary: 'Get compliance report' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getComplianceReport(
    @Request() req,
    @Param('standard') standard: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    const report = await this.auditService.getComplianceReport(
      req.user.tenantId,
      standard as any,
      new Date(startDate),
      new Date(endDate),
    );
    return { success: true, data: report };
  }
}
