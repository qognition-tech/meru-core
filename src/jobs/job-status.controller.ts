import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { JobRunService } from './job-run.service';
import { JOB_CADENCE_MINUTES } from './jobs.controller';

/**
 * Scheduled-job health for the God UI.
 *
 * A separate controller from `JobsController` because the two have opposite
 * callers: that one is a machine endpoint behind `CRON_SECRET`, this is a
 * human operator holding a JWT. Bolting a JWT route onto a controller with a
 * class-level `CronSecretGuard` would mean the dashboard needed the cron
 * secret to read a status page.
 *
 * **Must be registered before `JobsController`** — that controller declares
 * `@Get(':job')`, and Express matches in registration order, so a later
 * registration would see "status" swallowed as a job name.
 */
@ApiTags('jobs')
@Controller('jobs')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class JobStatusController {
  constructor(private readonly jobRunService: JobRunService) {}

  @Get('status')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Last-run state for every scheduled job (God View)',
    description:
      'Durable, so it survives the serverless cold starts that make every ' +
      'invocation a fresh process. Jobs that have never run are listed with ' +
      '`lastRunAt: null` and `overdue: true` rather than omitted — a health ' +
      'view that silently drops a job that never ran is how "sanctions ' +
      'ingest was never scheduled" stays invisible. `overdue` allows two ' +
      'full cadence intervals so a scheduler firing on the boundary does not ' +
      'flap. `lastSuccessAt` is preserved across failures, so a job failing ' +
      'since Tuesday reads as such.',
  })
  @ApiResponse({ status: 200, description: 'Job status retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async status() {
    const jobs = await this.jobRunService.status(JOB_CADENCE_MINUTES);
    return {
      jobs,
      overdue: jobs.filter((j) => j.overdue).map((j) => j.job),
      failing: jobs.filter((j) => j.lastStatus === 'failed').map((j) => j.job),
    };
  }
}
