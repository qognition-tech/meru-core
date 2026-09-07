import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../iam/decorators/public.decorator';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { CapabilitiesService } from './capabilities.service';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly capabilities: CapabilitiesService
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness + readiness probe (checks DB)' })
  @ApiResponse({ status: 200, description: 'Service healthy' })
  @ApiResponse({ status: 503, description: 'Service unhealthy' })
  async check() {
    let database = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'meru-core',
      vertical: process.env.VERTICAL || 'core',
      database,
      // Counts only. This route is public, so naming which credentials are
      // absent would hand an unauthenticated caller a reconnaissance list.
      capabilities: await this.capabilities.summary(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Which credentials are missing, and what each one breaks.
   *
   * platform_admin only, and guarded with a PlatformRole member rather than a
   * string — `@Roles('admin')` is a role no user holds, which makes a route
   * unreachable rather than protected. That mistake has been made twice here.
   *
   * The third mistake was subtler: `@Roles` sat here with nothing that reads
   * it. `GlobalAuthGuard` (APP_GUARD) authenticates every non-`@Public` route
   * and fills `request.user`, but role checks are `PolicyGuard`'s job and this
   * controller applied it nowhere — so the restriction was inert and any
   * authenticated caller of any role, `client` included, got the report.
   *
   * The role is therefore checked inline rather than through
   * `@UseGuards(PolicyGuard)`. That guard needs `VerticalPolicyService`, which
   * `HealthModule` does not provide, so using it means importing `IamModule`
   * here. That import looks safe — only `app.module.ts` imports
   * `HealthModule`, and nothing outside `src/health/` consumes
   * `CapabilitiesService`, so there is no cycle — but "looks safe" is settled
   * at *runtime*: a Nest wiring fault surfaces as an undefined injected
   * provider, not a build error, and this repo has already shipped a commit
   * that mapped every route and then failed to boot for exactly that reason.
   * An inline check cannot fail that way at all. Move it to the guard
   * (ADR 0007 D4) once someone can boot locally and read the route table.
   *
   * Class-level guards are not an option regardless: `GET /health` above is
   * `@Public()` and must stay anonymous.
   */
  @Get('capabilities')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Per-capability configuration report' })
  @ApiResponse({ status: 200, description: 'Capability report' })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  async capabilityReport(@Req() req: { user?: { roles?: string[] } }) {
    const roles = req.user?.roles ?? [];
    if (!roles.includes(PlatformRole.PLATFORM_ADMIN)) {
      // 403, not 404: the caller is authenticated and the route's existence is
      // already public knowledge from the OpenAPI spec. What must not leak is
      // the body — it names which credentials are missing, which is why the
      // public `/health` above deliberately returns counts only.
      throw new ForbiddenException('Insufficient Role Privileges');
    }
    return {
      capabilities: await this.capabilities.report(),
      summary: await this.capabilities.summary(),
    };
  }
}
