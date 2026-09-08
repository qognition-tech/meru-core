import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from '../common/types';
import { AlertRuleService } from './alert-rule.service';

export class ListResolvedAlertsQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Reading back what the alert sweep found.
 *
 * `AlertRuleService.listOpen` and `.listResolved` were written, tested and
 * complete — `listOpen`'s own comment says "what an alerts page renders" — and
 * had **no HTTP route at all**. The sweep on `/jobs/tick` wrote `alert_firings`
 * rows that nothing could ever read: no open-alerts list, no resolution state,
 * no way for a UI to show that an alert closed rather than silently vanished.
 *
 * That matters beyond a missing screen. The reconciliation alert the immigration
 * pack needs — a matter at or beyond `lodged` whose government charge is not
 * verified, which `immistack/CLAUDE.md` §4.4 calls the most damaging state this
 * product can create — is authored as an `alertRules[]` entry. Its blocking
 * banner and its reasoned dismissal both need somewhere to read from, and until
 * now there was nowhere.
 *
 * Firings are not silent today: the sweep also creates `Notification` rows and,
 * where the rule sets `createTask`, Tasks — both readable. What is missing is
 * the firing record itself, which is the only thing that carries *why* and
 * *since when*.
 *
 * Staff and above. A `client` has no business reading a firm's compliance
 * alerts, and unlike `/crm/entities` there is no subject-scoped view of one.
 */
@ApiTags('rules')
@Controller('alerts')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class AlertRuleController {
  constructor(private readonly alertRules: AlertRuleService) {}

  @Get()
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)
  @ApiOperation({
    summary: 'Open (unresolved) alert firings for the caller’s tenant',
    description:
      'Newest first, capped at 200. An empty list means the sweep found ' +
      'nothing OR has not run — check `GET /jobs/status` before reading it ' +
      'as "no alerts". The two are not the same answer and this route cannot ' +
      'tell them apart.',
  })
  @ApiResponse({ status: 200, description: 'Open alert firings' })
  async listOpen(@Request() req: AuthenticatedRequest) {
    return this.alertRules.listOpen(req.user.tenantId);
  }

  @Get('resolved')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)
  @ApiOperation({
    summary: 'Recently resolved alert firings',
    description:
      'So a UI can show that an alert closed rather than vanished — an alert ' +
      'that disappears without explanation reads as a bug, and then the next ' +
      'real one gets ignored.',
  })
  @ApiResponse({ status: 200, description: 'Resolved alert firings' })
  async listResolved(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListResolvedAlertsQueryDto,
  ) {
    return this.alertRules.listResolved(req.user.tenantId, query.limit ?? 50);
  }
}
