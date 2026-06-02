import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { Task } from './entities/task.entity';
import { TaskComment } from './entities/task-comment.entity';
import { RecurringJob } from './entities/recurring-job.entity';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, TaskComment, RecurringJob]),
    SearchModule,
    forwardRef(() => DocumentsModule),
    forwardRef(() => AiModule),
    AuditModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TasksModule {}
