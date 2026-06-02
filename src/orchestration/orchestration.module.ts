import { Module, forwardRef } from '@nestjs/common';
import { OrchestrationController } from './orchestration.controller';
import { OrchestrationService } from './orchestration.service';
import { CrmModule } from '../crm/crm.module';
import { SearchModule } from '../search/search.module';
import { AiModule } from '../ai/ai.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [forwardRef(() => CrmModule), SearchModule, forwardRef(() => AiModule), AnalyticsModule, AuditModule],
  controllers: [OrchestrationController],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
