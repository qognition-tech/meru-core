import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import {
  TenantProvisioningService,
  type CreateTenantDto,
} from './tenant-provisioning.service';
import { TenantPlan } from './entities/tenant.entity';

@ApiTags('tenant-provisioning')
@Controller('tenants')
export class TenantProvisioningController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new workspace (tenant)' })
  @ApiResponse({ status: 201, description: 'Workspace created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input or slug taken' })
  async signup(@Body() dto: CreateTenantDto) {
    const result = await this.tenantProvisioningService.createTenant(dto);

    return {
      success: true,
      message: 'Workspace created successfully',
      data: result,
    };
  }

  @Post('check-slug')
  @ApiOperation({ summary: 'Check if a workspace slug is available' })
  @ApiResponse({ status: 200, description: 'Slug availability checked' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', example: 'my-workspace' },
      },
      required: ['slug'],
    },
  })
  async checkSlug(@Body('slug') slug: string) {
    const result =
      await this.tenantProvisioningService.checkSlugAvailability(slug);

    return {
      success: true,
      data: result,
    };
  }

  // Guarded explicitly. There is no global APP_GUARD in this app — every
  // controller opts in — and this one had opted out entirely, leaving a
  // billing-mutating endpoint reachable unauthenticated by anyone who could
  // guess or observe a tenant id. `signup` and `check-slug` above stay public
  // by design; everything that touches an existing tenant does not.
  @Patch(':id/upgrade')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth()
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiOperation({ summary: 'Upgrade tenant plan' })
  @ApiResponse({ status: 200, description: 'Plan upgraded successfully' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        plan: { type: 'enum', enum: Object.values(TenantPlan) },
      },
      required: ['plan'],
    },
  })
  async upgradePlan(@Param('id') id: string, @Body('plan') plan: TenantPlan) {
    const tenant = await this.tenantProvisioningService.upgradeTenantPlan(
      id,
      plan,
    );

    return {
      success: true,
      message: 'Plan upgraded successfully',
      data: tenant,
    };
  }

  @Get(':id/stats')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth()
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiOperation({ summary: 'Get tenant statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  async getStats(@Param('id') id: string) {
    const stats = await this.tenantProvisioningService.getTenantStats(id);

    return {
      success: true,
      data: stats,
    };
  }
}
