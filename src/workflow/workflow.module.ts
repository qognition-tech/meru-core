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
  ],
  controllers: [WorkflowController],
  providers: [WorkflowEngineService],
  exports: [WorkflowEngineService],
})
export class WorkflowModule {}
