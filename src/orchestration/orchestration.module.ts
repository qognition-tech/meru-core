import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrchestrationController } from './orchestration.controller';
import { OrchestrationService } from './orchestration.service';
import { CrmModule } from '../crm/crm.module';
import { SearchModule } from '../search/search.module';
import { AiModule } from '../ai/ai.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { AgentRegistryService } from './agent-registry.service';
import { AgentRun } from './entities/agent-run.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentRun]),
    forwardRef(() => WorkflowModule),
    forwardRef(() => CrmModule),
    SearchModule,
    forwardRef(() => AiModule),
    AnalyticsModule,
    AuditModule,
  ],
  controllers: [OrchestrationController],
  providers: [OrchestrationService, AgentRegistryService],
  exports: [OrchestrationService, AgentRegistryService],
})
export class OrchestrationModule {}
