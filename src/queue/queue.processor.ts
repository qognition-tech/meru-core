import {
  Processor,
  Process,
  OnQueueActive,
  OnQueueCompleted,
  OnQueueFailed,
} from '@nestjs/bull';
import { Logger, Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bull';
import { QueueService } from './queue.service';
import { QueueJob } from './entities/job.entity';
import { JobType, JobResult, JobStatus } from './interfaces/job.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class JobProcessor implements OnModuleInit {
  private readonly logger = new Logger(JobProcessor.name);

  constructor(
    private queueService: QueueService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    // Start the job processor loop
    this.startProcessorLoop();
  }

  private async startProcessorLoop(): Promise<void> {
    while (true) {
      try {
        // Get next available job (all types)
        const job = await this.queueService.getNextJob(Object.values(JobType));

        if (job) {
          await this.processJobInternal(job);
        } else {
          // No jobs available, wait before checking again
          await this.sleep(1000);
        }
      } catch (error) {
        this.logger.error(`Processor loop error: ${error.message}`);
        await this.sleep(5000);
      }
    }
  }

  private async processJobInternal(job: QueueJob): Promise<void> {
    const startTime = Date.now();

    try {
      this.logger.log(`Processing job: ${job.id} (${job.type})`);

      // Emit event for specific job type handler
      const handlerResult = await new Promise<JobResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Job timeout: ${job.id}`));
        }, job.options.timeout || 300000); // Default 5 minutes

        this.eventEmitter.emit(`queue.job.${job.type}`, {
          job,
          resolve: (result: JobResult) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });

        // If no handler registered, resolve with default
        setTimeout(() => {
          clearTimeout(timeout);
          resolve({
            success: true,
            data: { message: 'No handler registered for this job type' },
          });
        }, 100);
      });

      await this.queueService.completeJob(job.id, handlerResult);

      this.logger.log(
        `Job completed: ${job.id} in ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      const shouldRetry = job.attempts < job.maxAttempts;
      await this.queueService.failJob(job.id, error.message, shouldRetry);

      this.logger.error(`Job failed: ${job.id} - ${error.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Bull queue decorators for external Bull queue support (optional)
  @OnQueueActive()
  onActive(job: Job) {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
  }

  @OnQueueCompleted()
  onCompleted(job: Job, result: any) {
    this.logger.log(`Job ${job.id} completed with result:`, result);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.error(`Job ${job.id} failed with error:`, err.message);
  }
}

// Job handlers - These would be implemented in respective modules

@Injectable()
export class DocumentJobHandler {
  private readonly logger = new Logger(DocumentJobHandler.name);

  constructor(private eventEmitter: EventEmitter2) {}

  onModuleInit() {
    // Register handlers
    this.eventEmitter.on(
      'queue.job.document:process',
      this.handleDocumentProcess.bind(this),
    );
    this.eventEmitter.on(
      'queue.job.document:ocr',
      this.handleDocumentOcr.bind(this),
    );
  }

  private async handleDocumentProcess({ job, resolve, reject }: any) {
    try {
      this.logger.log(`Processing document: ${job.data.payload.documentId}`);

      // Implementation would call documents service
      resolve({
        success: true,
        data: { processed: true },
      });
    } catch (error) {
      reject(error);
    }
  }

  private async handleDocumentOcr({ job, resolve, reject }: any) {
    try {
      this.logger.log(`OCR for document: ${job.data.payload.documentId}`);

      resolve({
        success: true,
        data: { text: 'OCR result' },
      });
    } catch (error) {
      reject(error);
    }
  }
}

@Injectable()
export class EmailJobHandler {
  private readonly logger = new Logger(EmailJobHandler.name);

  constructor(private eventEmitter: EventEmitter2) {}

  onModuleInit() {
    this.eventEmitter.on(
      'queue.job.email:send',
      this.handleEmailSend.bind(this),
    );
  }

  private async handleEmailSend({ job, resolve, reject }: any) {
    try {
      this.logger.log(`Sending email to: ${job.data.payload.to}`);

      // Implementation would call email service
      resolve({
        success: true,
        data: { sent: true },
      });
    } catch (error) {
      reject(error);
    }
  }
}

@Injectable()
export class AIJobHandler {
  private readonly logger = new Logger(AIJobHandler.name);

  constructor(private eventEmitter: EventEmitter2) {}

  onModuleInit() {
    this.eventEmitter.on(
      'queue.job.ai:analysis',
      this.handleAIAnalysis.bind(this),
    );
    this.eventEmitter.on(
      'queue.job.ai:embedding',
      this.handleAIEmbedding.bind(this),
    );
  }

  private async handleAIAnalysis({ job, resolve, reject }: any) {
    try {
      this.logger.log(
        `AI analysis for: ${job.data.payload.entityType} ${job.data.payload.entityId}`,
      );

      resolve({
        success: true,
        data: { analysis: 'AI analysis result' },
      });
    } catch (error) {
      reject(error);
    }
  }

  private async handleAIEmbedding({ job, resolve, reject }: any) {
    try {
      this.logger.log(
        `Generating embeddings for: ${job.data.payload.entityId}`,
      );

      resolve({
        success: true,
        data: { embedding: [] },
      });
    } catch (error) {
      reject(error);
    }
  }
}
