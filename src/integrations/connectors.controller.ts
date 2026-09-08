import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
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
import { ConnectorsService } from './services/connectors.service';
import { UpsertConnectorDto } from './dto/upsert-connector.dto';

interface ConnectorRequest {
  user: { id: string; tenantId: string };
  tenantVertical: string | null;
}

/**
 * Per-tenant regulator connector management — "connect UAE Central Bank /
 * choose SAMA / QCB" for GovX, "choose AU / CA / UK / NZ" for ImmiStack. The
 * catalogue is filtered to the caller's vertical; enabling live mode without
 * credentials is rejected; credentials go in encrypted and never come back
 * out (only `hasCredentials`).
 */
@Controller('integrations/connectors')
@ApiTags('integrations')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class ConnectorsController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  @Get()
  @ApiOperation({
    summary: "List regulator connectors available to this tenant's vertical",
  })
  @ApiResponse({ status: 200, description: 'Connector catalogue + state' })
  list(@Request() req: ConnectorRequest) {
    return this.connectorsService.listForTenant(
      req.user.tenantId,
      req.tenantVertical,
    );
  }

  @Put(':code')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({ summary: 'Enable/disable a connector or set its credentials' })
  @ApiParam({ name: 'code', example: 'uae-central-bank' })
  @ApiResponse({ status: 200, description: 'Connector state saved' })
  @ApiResponse({
    status: 400,
    description: 'Adapter not in this vertical, or live mode without credentials',
  })
  upsert(
    @Request() req: ConnectorRequest,
    @Param('code') code: string,
    @Body() dto: UpsertConnectorDto,
  ) {
    return this.connectorsService.upsert(
      req.user.tenantId,
      req.tenantVertical,
      code,
      dto,
    );
  }
}
