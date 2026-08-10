import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { Report } from './entities/report.entity';
import { ReportExecution } from './entities/report-execution.entity';
import { DashboardWidget } from './entities/dashboard-widget.entity';
import { SearchModule } from '../search/search.module';
import { AiModule } from '../ai/ai.module';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { PackDashboardService } from './pack-dashboard.service';
import { RuleEvaluatorModule } from '../rules/rule-evaluator.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { TenantModule } from '../tenant/tenant.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Report,
      ReportExecution,
      DashboardWidget,
      // Pack dashboards count and filter the tenant's own records; the widget
      // source is an entity type.
      UniversalEntity,
    ]),
    SearchModule,
    forwardRef(() => AiModule),
    RuleEvaluatorModule,
    VerticalPackModule,
    // forwardRef: TenantModule now reaches IamModule, which reaches back into
    // TenantModule. Nest resolves that pair, but only if every edge into it is
    // lazy.
    forwardRef(() => TenantModule),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, PackDashboardService],
  exports: [AnalyticsService, PackDashboardService],
})
export class AnalyticsModule {}
