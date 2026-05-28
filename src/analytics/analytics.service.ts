import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import {
  Report,
  ReportType,
  DataSource as ReportDataSource,
} from './entities/report.entity';
import { ReportExecution } from './entities/report-execution.entity';
import {
  DashboardWidget,
  WidgetType,
} from './entities/dashboard-widget.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';

export interface CreateReportDto {
  name: string;
  description?: string;
  reportType: ReportType;
  dataSource: ReportDataSource;
  configuration: any;
  schedule?: any;
}

export interface ExecuteReportDto {
  reportId: string;
  parameters?: Record<string, any>;
  format?: 'json' | 'csv' | 'xlsx' | 'pdf';
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(Report)
    private reportRepo: Repository<Report>,
    @InjectRepository(ReportExecution)
    private executionRepo: Repository<ReportExecution>,
    @InjectRepository(DashboardWidget)
    private widgetRepo: Repository<DashboardWidget>,
    private dataSource: DataSource,
    private searchService: SearchService,
    private aiService: AiService,
  ) {}

  // ==================== REPORT BUILDER ====================

  async createReport(
    tenantId: string,
    userId: string,
    dto: CreateReportDto,
  ): Promise<Report> {
    const report = this.reportRepo.create({
      tenantId,
      createdBy: userId,
      ...dto,
    });

    const saved = await this.reportRepo.save(report);
    this.logger.log(`Report created: ${saved.id}`);
    return saved;
  }

  async getReports(
    tenantId: string,
    dataSource?: ReportDataSource,
  ): Promise<Report[]> {
    const where: any = { tenantId, status: 'active' };
    if (dataSource) {
      where.dataSource = dataSource;
    }

    return this.reportRepo.find({ where });
  }

  async getReport(id: string, tenantId: string): Promise<Report> {
    const report = await this.reportRepo.findOne({
      where: { id, tenantId },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    return report;
  }

  // ==================== REPORT EXECUTION ====================

  async executeReport(
    tenantId: string,
    userId: string,
    dto: ExecuteReportDto,
  ): Promise<any> {
    const startTime = Date.now();
    const report = await this.getReport(dto.reportId, tenantId);

    try {
      // Build and execute query based on report configuration
      const results = await this.executeQuery(report, dto.parameters);

      // Store execution
      const execution = await this.executionRepo.save({
        tenantId,
        reportId: report.id,
        executedAt: new Date(),
        executedBy: userId,
        parameters: dto.parameters || {},
        results,
        rowCount: Array.isArray(results) ? results.length : 0,
        executionTimeMs: Date.now() - startTime,
        status: 'success',
      });

      // AI insights
      let aiInsights = null;
      try {
        aiInsights = await this.generateAIInsights(report, results);
      } catch (aiError) {
        this.logger.debug(`AI insights not available for report ${report.id}`);
      }

      return {
        success: true,
        data: results,
        executionId: execution.id,
        executionTime: execution.executionTimeMs,
        aiInsights,
      };
    } catch (error) {
      // Store failed execution
      await this.executionRepo.save({
        tenantId,
        reportId: report.id,
        executedAt: new Date(),
        executedBy: userId,
        parameters: dto.parameters || {},
        executionTimeMs: Date.now() - startTime,
        status: 'error',
        errorMessage: error.message,
      });

      throw error;
    }
  }

  private async executeQuery(
    report: Report,
    parameters?: Record<string, any>,
  ): Promise<any> {
    const config = report.configuration;
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      let query = '';
      const params: any[] = [];

      // Build query based on data source
      switch (report.dataSource) {
        case ReportDataSource.CRM:
          query = this.buildCRMQuery(config, params, parameters);
          break;
        case ReportDataSource.WORKFLOW:
          query = this.buildWorkflowQuery(config, params, parameters);
          break;
        case ReportDataSource.DOCUMENTS:
          query = this.buildDocumentsQuery(config, params, parameters);
          break;
        case ReportDataSource.TASKS:
          query = this.buildTasksQuery(config, params, parameters);
          break;
        case ReportDataSource.FORMS:
          query = this.buildFormsQuery(config, params, parameters);
          break;
        case ReportDataSource.BILLING:
          query = this.buildBillingQuery(config, params, parameters);
          break;
        default:
          throw new BadRequestException('Unsupported data source');
      }

      const results = await queryRunner.query(query, params);
      return results;
    } finally {
      await queryRunner.release();
    }
  }

  private buildCRMQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    let query = 'SELECT ';

    if (config.columns) {
      query += config.columns.map((c: any) => c.field).join(', ');
    } else {
      query += '*';
    }

    query += ' FROM universal_entities WHERE tenant_id = $1';
    params.push(parameters?.tenantId);

    if (config.filters) {
      config.filters.forEach((filter: any, index: number) => {
        query += ` AND ${filter.field} ${filter.operator} $${params.length + 1}`;
        params.push(filter.value);
      });
    }

    if (config.groupBy) {
      query += ` GROUP BY ${config.groupBy.join(', ')}`;
    }

    if (config.sort) {
      query += ` ORDER BY ${config.sort.field} ${config.sort.direction}`;
    }

    if (config.limit) {
      query += ` LIMIT ${config.limit}`;
    }

    return query;
  }

  private buildWorkflowQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    let query = 'SELECT * FROM workflow_instances WHERE tenant_id = $1';
    params.push(parameters?.tenantId);

    if (parameters?.workflowId) {
      query += ` AND workflow_id = $${params.length + 1}`;
      params.push(parameters.workflowId);
    }

    return query;
  }

  private buildDocumentsQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    let query = 'SELECT * FROM documents WHERE tenant_id = $1';
    params.push(parameters?.tenantId);

    if (parameters?.entityType) {
      query += ` AND linked_entity_type = $${params.length + 1}`;
      params.push(parameters.entityType);
    }

    return query;
  }

  private buildTasksQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    let query = 'SELECT * FROM tasks WHERE tenant_id = $1';
    params.push(parameters?.tenantId);

    if (parameters?.assignedTo) {
      query += ` AND assigned_to = $${params.length + 1}`;
      params.push(parameters.assignedTo);
    }

    return query;
  }

  private buildFormsQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    const query = 'SELECT * FROM form_submissions WHERE tenant_id = $1';
    params.push(parameters?.tenantId);
    return query;
  }

  private buildBillingQuery(
    config: any,
    params: any[],
    parameters?: Record<string, any>,
  ): string {
    let query = 'SELECT * FROM invoices WHERE tenant_id = $1';
    params.push(parameters?.tenantId);

    if (parameters?.startDate && parameters?.endDate) {
      query += ` AND created_at BETWEEN $${params.length + 1} AND $${params.length + 2}`;
      params.push(parameters.startDate, parameters.endDate);
    }

    return query;
  }

  // ==================== AI INSIGHTS ====================

  private async generateAIInsights(report: Report, data: any[]): Promise<any> {
    if (data.length === 0) return null;

    const analysis = await this.aiService.execute({
      category: 'data_analysis' as any,
      key: 'report_insights',
      input: JSON.stringify({
        reportName: report.name,
        dataSource: report.dataSource,
        rowCount: data.length,
        sample: data.slice(0, 10),
      }),
      context: { tenantId: report.tenantId },
    });

    return JSON.parse(analysis.result);
  }

  // ==================== DASHBOARD WIDGETS ====================

  async createWidget(
    tenantId: string,
    dto: Partial<DashboardWidget>,
  ): Promise<DashboardWidget> {
    const widget = this.widgetRepo.create({
      tenantId,
      ...dto,
    });

    const saved = await this.widgetRepo.save(widget);
    this.logger.log(`Widget created: ${saved.id}`);
    return saved;
  }

  async getWidgets(tenantId: string): Promise<DashboardWidget[]> {
    return this.widgetRepo.find({
      where: { tenantId, status: 'active' },
      order: { position: 'ASC' },
    });
  }

  async executeWidget(tenantId: string, widgetId: string): Promise<any> {
    const widget = await this.widgetRepo.findOne({
      where: { id: widgetId, tenantId },
    });

    if (!widget) {
      throw new NotFoundException('Widget not found');
    }

    // Execute widget query
    const results = await this.executeWidgetQuery(widget, tenantId);

    return {
      success: true,
      data: results,
      widget: {
        id: widget.id,
        name: widget.name,
        type: widget.widgetType,
        configuration: widget.configuration,
      },
    };
  }

  private async executeWidgetQuery(
    widget: DashboardWidget,
    tenantId: string,
  ): Promise<any> {
    const config = widget.configuration;
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      const query = config.query;
      const params: any[] = [tenantId];

      // Add filters
      if (query.filters) {
        Object.entries(query.filters).forEach(([key, value]) => {
          params.push(value);
        });
      }

      const results = await queryRunner.query(
        `SELECT ${query.fields.join(', ')} FROM ${query.table} WHERE tenant_id = $1 LIMIT 100`,
        params,
      );

      return results;
    } finally {
      await queryRunner.release();
    }
  }

  // ==================== SCHEDULED REPORTS ====================

  @Cron(CronExpression.EVERY_HOUR)
  async processScheduledReports(): Promise<void> {
    this.logger.log('Processing scheduled reports...');

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDay = now.getDay();
    const currentDate = now.getDate();

    // Query all active reports and filter by schedule in code
    // TypeORM doesn't support deep JSONB querying with dot notation in where clause
    const allReports = await this.reportRepo.find({
      where: {
        status: 'active',
      },
    });

    const reports = allReports.filter(
      (report) => report.schedule?.enabled === true,
    );

    for (const report of reports) {
      const schedule = report.schedule;
      if (!schedule?.enabled) continue;

      // Check if it's time to run
      const [scheduleHour, scheduleMinute] = schedule.time
        .split(':')
        .map(Number);

      if (currentHour !== scheduleHour || currentMinute !== scheduleMinute) {
        continue;
      }

      // Check frequency
      let shouldRun = false;
      switch (schedule.frequency) {
        case 'daily':
          shouldRun = true;
          break;
        case 'weekly':
          shouldRun = currentDay === schedule.dayOfWeek;
          break;
        case 'monthly':
          shouldRun = currentDate === schedule.dayOfMonth;
          break;
      }

      if (shouldRun) {
        try {
          this.logger.log(`Executing scheduled report: ${report.id}`);

          const result = await this.executeReport(report.tenantId, 'system', {
            reportId: report.id,
            format: schedule.format,
          });

          // TODO: Send email to recipients
          this.logger.log(`Report ${report.id} executed successfully`);
        } catch (error) {
          this.logger.error(
            `Failed to execute scheduled report ${report.id}:`,
            error,
          );
        }
      }
    }
  }

  // ==================== EXPORT ====================

  async exportReport(
    tenantId: string,
    reportId: string,
    format: 'csv' | 'xlsx' | 'pdf',
  ): Promise<{ fileUrl: string }> {
    const report = await this.getReport(reportId, tenantId);
    const result = await this.executeReport(tenantId, 'system', { reportId });

    // TODO: Implement actual export logic
    // For now, return a placeholder
    return {
      fileUrl: `/api/analytics/reports/${reportId}/download`,
    };
  }
}
