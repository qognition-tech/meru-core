import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QueueJob,
      QueueJobLog,
      QueueScheduledJob,
      QueueWorker,
    ]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
          password: configService.get('REDIS_PASSWORD'),
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'default',
    }),
  ],
  providers: [
    QueueService,
    JobProcessor,
    DocumentJobHandler,
    EmailJobHandler,
    AIJobHandler,
  ],
  controllers: [QueueController],
  exports: [QueueService],
})
export class QueueModule {}
