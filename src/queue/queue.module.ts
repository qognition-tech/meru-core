import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import {
  JobProcessor,
  DocumentJobHandler,
  EmailJobHandler,
  AIJobHandler,
} from './queue.processor';
import {
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
  QueueWorker,
} from './entities/job.entity';
import { IamModule } from '../iam/iam.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QueueJob,
      QueueJobLog,
      QueueScheduledJob,
      QueueWorker,
    ]),
    IamModule,
    // No BullModule here on purpose. This queue is Postgres-backed — jobs live
    // in `queue_jobs` and JobProcessor polls them via QueueService.getNextJob().
    // Nothing in the codebase injects a Bull queue or declares a @Processor, so
    // registering Bull only opened an ioredis connection to localhost:6379 that
    // no code used. When Redis was absent (any dev machine without it, and
    // Vercel) ioredis retried forever during module init, so the app blocked in
    // bootstrap and never reached app.listen() — silently, with no output.
  ],
  providers: [
    QueueService,
    JobProcessor,
    DocumentJobHandler,
    EmailJobHandler,
    AIJobHandler,
  ],
  controllers: [QueueController],
  // JobProcessor is exported so the cron entrypoints in src/jobs can drain the
  // queue on the serverless runtime, where its polling loop is disabled.
  exports: [QueueService, JobProcessor],
})
export class QueueModule {}
