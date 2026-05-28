import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScreeningEngine } from './engines/screening.engine';
import { DocIntelEngine } from './engines/doc-intel.engine';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([AiPrompt, AiEmbedding]),
    CoreModule,
    forwardRef(() => CrmModule),
    forwardRef(() => WorkflowModule),
    forwardRef(() => TasksModule),
    forwardRef(() => FormsModule),
    forwardRef(() => DocumentsModule),
    forwardRef(() => BillingModule),
    forwardRef(() => AnalyticsModule),
    forwardRef(() => AuditModule),
  ],
  controllers: [AiController],
  providers: [AiService, ScreeningEngine, DocIntelEngine],
  exports: [AiService, ScreeningEngine, DocIntelEngine],
})
export class AiModule {}
