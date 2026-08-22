import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow.service';
import { SlaWatchdogService } from './services/sla-watchdog.service';
import { TatService } from './services/tat.service';
import { Workflow } from './entities/workflow.entity';
import { WorkflowState } from './entities/workflow-state.entity';
import { WorkflowTransition } from './entities/workflow-transition.entity';
import { WorkflowInstance } from './entities/workflow-instance.entity';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';
import { BillingModule } from '../billing/billing.module';
import { RuleEvaluatorModule } from '../rules/rule-evaluator.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { PackWorkflowService } from './services/pack-workflow.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Workflow,
      WorkflowState,
      WorkflowTransition,
      WorkflowInstance,
    ]),
    SearchModule,
    forwardRef(() => DocumentsModule),
    forwardRef(() => AiModule),
    AuditModule,
    NotificationsModule,
    TasksModule,
    // The payment gate reads the pack's payment plans and the case's arrears.
    forwardRef(() => BillingModule),
    // Pack transition conditions are JsonLogic; pack workflows come from L4.
    RuleEvaluatorModule,
    VerticalPackModule,
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowEngineService,
    SlaWatchdogService,
    TatService,
    PackWorkflowService,
  ],
  exports: [
    WorkflowEngineService,
    SlaWatchdogService,
    TatService,
    PackWorkflowService,
  ],
})
export class WorkflowModule {}
