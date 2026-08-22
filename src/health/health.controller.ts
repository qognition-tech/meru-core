import { Controller, Get } from '@nestjs/common';
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
   */
  @Get('capabilities')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Per-capability configuration report' })
  @ApiResponse({ status: 200, description: 'Capability report' })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  async capabilityReport() {
    return {
      capabilities: await this.capabilities.report(),
      summary: await this.capabilities.summary(),
    };
  }
}
