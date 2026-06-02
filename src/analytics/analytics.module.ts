import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { Report } from './entities/report.entity';
import { ReportExecution } from './entities/report-execution.entity';
import { DashboardWidget } from './entities/dashboard-widget.entity';
import { SearchModule } from '../search/search.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Report, ReportExecution, DashboardWidget]),
    SearchModule,
    forwardRef(() => AiModule),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
