import {
  Body,
  Controller,
  Get,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { Roles } from '../../iam/decorators/roles.decorator';
import { PlatformRole } from '../../iam/enums/platform-role.enum';
import { BrandingService } from '../services/branding.service';
import { BrandingDto } from '../dto/branding.dto';
import type { AuthenticatedRequest } from '../../common/types';

/**
 * White-label branding for the vertical apps. The shell fetches this on every
 * load, so reads are open to any authenticated member; writes are admin-only
 * because branding is tenant-wide. The first-login onboarding wizard writes
 * here and sets onboardingComplete.
 */
@Controller('tenant/branding')
@ApiTags('tenant')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class BrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Get()
  @ApiOperation({ summary: "The caller tenant's branding" })
  @ApiResponse({ status: 200, description: 'Branding retrieved' })
  get(@Request() req: AuthenticatedRequest) {
    return this.brandingService.get(req.user.tenantId);
  }

  @Put()
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({ summary: 'Update branding (onboarding wizard writes here)' })
  @ApiResponse({ status: 200, description: 'Branding saved' })
  update(@Request() req: AuthenticatedRequest, @Body() dto: BrandingDto) {
    return this.brandingService.update(req.user.tenantId, dto);
  }
}
