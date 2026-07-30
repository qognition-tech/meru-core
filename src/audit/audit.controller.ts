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
  ParseEnumPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from './audit.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import type { Response } from 'express';
import { paginated } from '../common/paginated';
import { DateRangeQueryDto } from '../common/dto/date-range.dto';
import { ExportLogsDto } from './dto/export-logs.dto';
import { ComplianceStandard } from './entities/audit-log.entity';

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
    const limit = query.limit ? parseInt(query.limit, 10) : 100;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    const result = await this.auditService.queryLogs({
      tenantId: req.user.tenantId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      userId: query.userId,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      severity: query.severity,
      limit,
      offset,
    });

    // The total used to ride along inside the payload, where the envelope
    // buried it; it now lands in `meta.pagination` as the contract specifies.
    return paginated(
      result.logs,
      result.total,
      Math.floor(offset / (limit || 1)) + 1,
      limit,
    );
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
    return logs;
  }

  @Get('logs/user/:userId')
  @ApiOperation({ summary: 'Get user activity' })
  @ApiResponse({ status: 400, description: 'Missing or malformed date range' })
  async getUserActivity(
    @Request() req,
    @Param('userId') userId: string,
    @Query() range: DateRangeQueryDto,
  ) {
    const logs = await this.auditService.getUserActivity(
      req.user.tenantId,
      userId,
      new Date(range.startDate),
      new Date(range.endDate),
    );
    return logs;
  }

  @Post('logs/verify')
  @ApiOperation({ summary: 'Verify per-row checksums for all tenant logs' })
  async verifyIntegrity(@Request() req) {
    const result = await this.auditService.verifyTenantLogs(req.user.tenantId);
    return result;
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
        status: 'valid',
        total: 142,
        valid: 142,
        details: 'Chain intact (142 logs verified)',
      },
    },
  })
  async verifyChain(@Request() req) {
    const result = await this.auditService.verifyChain(req.user.tenantId);
    return result;
  }

  @Post('logs/export')
  @ApiOperation({ summary: 'Export audit logs' })
  async exportLogs(
    @Request() req,
    @Body() body: ExportLogsDto,
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
  @ApiParam({ name: 'standard', enum: ComplianceStandard })
  @ApiResponse({ status: 400, description: 'Unknown standard, or bad dates' })
  async getComplianceReport(
    @Request() req,
    // Validated against the enum. An unknown value used to reach Postgres and
    // 500 with `invalid input value for enum
    // audit_logs_compliancestandard_enum: "..."`.
    @Param('standard', new ParseEnumPipe(ComplianceStandard))
    standard: ComplianceStandard,
    @Query() range: DateRangeQueryDto,
  ) {
    const report = await this.auditService.getComplianceReport(
      req.user.tenantId,
      standard,
      new Date(range.startDate),
      new Date(range.endDate),
    );
    return report;
  }
}
