import {
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SlaWatchdogService } from '../workflow/services/sla-watchdog.service';
import { BillingService } from '../billing/billing.service';
import { Public } from '../iam/decorators/public.decorator';
import { CronSecretGuard } from './cron-secret.guard';

export interface JobResult {
  job: string;
  status: 'ok';
  durationMs: number;
}

/**
 * Vercel Cron entrypoints.
 *
 * `@nestjs/schedule` @Cron decorators never fire on Vercel's serverless
 * runtime, so the scheduled jobs are exposed as HTTP endpoints that Vercel
 * Cron invokes with `Authorization: Bearer <CRON_SECRET>`.
 */
@Controller('jobs')
@ApiTags('jobs')
@Public()
@UseGuards(CronSecretGuard)
@ApiHeader({
  name: 'Authorization',
  description: 'Bearer <CRON_SECRET>',
  required: true,
})
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    private readonly slaWatchdogService: SlaWatchdogService,
    private readonly billingService: BillingService,
  ) {}

  @Post('sla-watchdog')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the workflow SLA watchdog (Vercel Cron entrypoint)',
    description:
      'Scans active workflow instances for breached SLA deadlines and runs escalations. Requires the CRON_SECRET bearer token.',
  })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 401, description: 'Missing or invalid cron secret' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  async runSlaWatchdog(): Promise<JobResult> {
    return this.run('sla-watchdog', () =>
      this.slaWatchdogService.checkSLAViolations(),
    );
  }

  @Post('daily-billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the daily billing cycle (Vercel Cron entrypoint)',
    description:
      'Generates invoices for subscriptions ending their period, advances billing periods and resets usage counters. Requires the CRON_SECRET bearer token.',
  })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 401, description: 'Missing or invalid cron secret' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  async runDailyBilling(): Promise<JobResult> {
    return this.run('daily-billing', () =>
      this.billingService.processDailyBilling(),
    );
  }

  private async run(
    job: string,
    fn: () => Promise<unknown>,
  ): Promise<JobResult> {
    const startedAt = Date.now();
    this.logger.log(`Cron job "${job}" started`);

    try {
      await fn();
      const durationMs = Date.now() - startedAt;
      this.logger.log(`Cron job "${job}" completed in ${durationMs}ms`);
      return { job, status: 'ok', durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      this.logger.error(
        `Cron job "${job}" failed after ${durationMs}ms: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException({
        job,
        status: 'error',
        durationMs,
        message: `Cron job "${job}" failed: ${message}`,
      });
    }
  }
}
