import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow.service';
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
  ],
  controllers: [WorkflowController],
  providers: [WorkflowEngineService],
  exports: [WorkflowEngineService],
})
export class WorkflowModule {}
