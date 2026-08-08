import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScreeningEngine } from './engines/screening.engine';
import { EnginesController } from './engines/engines.controller';
import { WatchlistIngestService } from './engines/watchlist-ingest.service';
import { WatchlistEntry } from './entities/watchlist-entry.entity';
import { ScreeningResult } from './entities/screening-result.entity';
import { RescreeningService } from './engines/rescreening.service';
import { DocIntelEngine } from './engines/doc-intel.engine';
import { DecisionEngine } from './engines/decision.engine';
import { CommsEngine } from './engines/comms.engine';
import { RegulatoryRadarEngine } from './engines/regulatory-radar.engine';
import { VesselTrackingEngine } from './engines/vessel-tracking.engine';
import { AiPrompt, AiEmbedding } from './entities/ai-prompt.entity';
import { CoreModule } from '../core/core.module';
import { CrmModule } from '../crm/crm.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TasksModule } from '../tasks/tasks.module';
import { FormsModule } from '../forms/forms.module';
import { DocumentsModule } from '../documents/documents.module';
import { BillingModule } from '../billing/billing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiPrompt,
      AiEmbedding,
      WatchlistEntry,
      ScreeningResult,
    ]),
    CoreModule,
    forwardRef(() => CrmModule),
    forwardRef(() => WorkflowModule),
    forwardRef(() => TasksModule),
    forwardRef(() => FormsModule),
    forwardRef(() => DocumentsModule),
    forwardRef(() => BillingModule),
    forwardRef(() => AnalyticsModule),
    forwardRef(() => AuditModule),
    forwardRef(() => NotificationsModule),
    // Layer 4: the vertical's prompt library. Not forwardRef'd — the resolver
    // module has one provider and one entity, so there is no cycle to break.
    VerticalPackModule,
  ],
  controllers: [AiController, EnginesController],
  providers: [
    RescreeningService,
    AiService,
    ScreeningEngine,
    WatchlistIngestService,
    DocIntelEngine,
    DecisionEngine,
    CommsEngine,
    RegulatoryRadarEngine,
    VesselTrackingEngine,
  ],
  exports: [
    RescreeningService,
    AiService,
    ScreeningEngine,
    WatchlistIngestService,
    DocIntelEngine,
    DecisionEngine,
    CommsEngine,
    RegulatoryRadarEngine,
    VesselTrackingEngine,
  ],
})
export class AiModule {}
