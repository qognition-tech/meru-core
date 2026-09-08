import { Controller, HttpCode, HttpStatus, Param, Post, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { TenancyService } from '../core/tenancy/tenancy.service';
import { JobDispatchService } from './job-dispatch.service';
import type { AuthenticatedRequest } from '../common/types';

/**
 * `POST /platform/jobs/:job/run` — ADR 0009 §2.3, the human-operator front
 * door onto `JobDispatchService.runNamed`, replacing `CRON_SECRET` for this
 * caller, not adding to it: `JobsController`'s `POST /jobs/:job` keeps
 * `CronSecretGuard` unchanged as the machine front door for the Vercel
 * crons, and this route uses `AuthGuard('jwt') + PolicyGuard +
 * @Roles(PLATFORM_ADMIN)` instead. Neither guard weakens the other — a
 * caller needs exactly one of a valid JWT with platform_admin, or the cron
 * secret, never either being sufficient for the other's route.
 *
 * **Lives in `JobsModule`, on a separate controller, not as a new method on
 * `IamModule`'s `PlatformController`.** `JobsModule` already imports
 * `IamModule` (`jobs.module.ts`) for `PolicyGuard`/`AuthGuard`, so
 * `IamModule` importing back to reach `JobDispatchService` would close the
 * exact cycle shape `CLAUDE.md` §8.2 already names as the cause of one
 * production `FUNCTION_INVOCATION_FAILED`. This module needs `TenancyModule`
 * for `runAsGod`, imported into `JobsModule` — confirmed no cycle:
 * `TenancyModule` imports only `AuditModule`, which `JobsModule` already
 * imports too. (`TenancyModule` is also `@Global()`, so `TenancyService`
 * would resolve here regardless — the explicit import is for the same
 * reason `jobs.module.ts`'s own header explains its other imports: legible
 * dependency graph over relying on globality.)
 *
 * Job-name validation, not a shared secret, is this route's fail-closed
 * check: an unrecognised `:job` is a 404 from `JobDispatchService.runNamed`
 * itself (`MER-RES-0001`, the same default a `NotFoundException` gets
 * everywhere else in the app), never a silent no-op.
 */
@ApiTags('platform')
@Controller('platform/jobs')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class PlatformJobsController {
  constructor(
    private readonly tenancyService: TenancyService,
    private readonly jobDispatchService: JobDispatchService,
  ) {}

  @Post(':job/run')
  @HttpCode(HttpStatus.OK)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Run a scheduled job on demand (God View)',
    description:
      'platform_admin only, audited via runAsGod. The human twin of ' +
      "POST /jobs/:job, which needs CRON_SECRET and is unusable from a " +
      'browser. Audited under the operator’s own tenant — a manual job run ' +
      'is a platform-wide action with no single target tenant, the same ' +
      'reasoning PlatformController.stats already uses for the same shape.',
  })
  @ApiParam({ name: 'job', description: 'Job name, as in GET /jobs/status' })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  @ApiResponse({ status: 404, description: 'Unknown job name' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  run(@Request() req: AuthenticatedRequest, @Param('job') job: string) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `Run job "${job}" on demand (God View)`,
      () => this.jobDispatchService.runNamed(job),
    );
  }
}
