import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Request,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import { Public } from '../iam/decorators/public.decorator';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from '../common/types';
import { InboundWebhookService } from './inbound-webhook.service';
import { CreateInboundEndpointDto } from './dto/create-endpoint.dto';

/**
 * The public receiver. Deliberately its own controller with no class-level
 * guard: `@Public()` only suppresses the global guard, and a class-level
 * `AuthGuard('jwt')` would still run (see stripe-webhook.controller.ts).
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class InboundWebhookReceiverController {
  constructor(private readonly inbound: InboundWebhookService) {}

  @Post('inbound/:endpointId')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a third-party webhook (public; signature-verified)',
    description:
      'The URL a tenant pastes into Cal.com, Dropbox Sign, a WhatsApp provider, etc. The raw body is verified against the endpoint’s scheme and secret, stored, and acknowledged with 200 `{eventId}`. A failed signature is stored as `rejected` and answered 401 so the sender retries. Unknown or inactive endpoint: 404.',
  })
  @ApiParam({ name: 'endpointId', description: 'From POST /webhooks/endpoints' })
  @ApiResponse({ status: 200, description: '`{eventId}`' })
  @ApiResponse({ status: 401, description: 'Signature did not verify' })
  @ApiResponse({ status: 404, description: 'No such endpoint' })
  async receive(
    @Param('endpointId') endpointId: string,
    @Req() req: RawBodyRequest<ExpressRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() ip: string,
  ) {
    return this.inbound.receive({
      endpointId,
      rawBody: req.rawBody,
      headers,
      sourceIp: ip ?? null,
    });
  }
}

@ApiTags('webhooks')
@ApiBearerAuth('JWT-auth')
@Controller('webhooks')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
export class InboundWebhookAdminController {
  constructor(private readonly inbound: InboundWebhookService) {}

  @Post('endpoints')
  @ApiOperation({
    summary: 'Register an inbound endpoint',
    description:
      'Returns the endpoint and its `secret` **once**; the secret is never returned again. The receive URL is `POST /api/v1/webhooks/inbound/{id}`.',
  })
  @ApiResponse({ status: 201, description: '`{endpoint, secret, url}`' })
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateInboundEndpointDto,
  ) {
    const created = await this.inbound.create(req.user.tenantId, dto);
    return {
      ...created,
      url: `/api/v1/webhooks/inbound/${created.endpoint.id}`,
    };
  }

  @Get('endpoints')
  @ApiOperation({ summary: "This tenant's inbound endpoints (secrets omitted)" })
  async list(@Request() req: AuthenticatedRequest) {
    return this.inbound.list(req.user.tenantId);
  }

  @Patch('endpoints/:id')
  @ApiOperation({ summary: 'Enable or disable an endpoint' })
  async setActive(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { active: boolean },
  ) {
    return this.inbound.setActive(req.user.tenantId, id, body?.active !== false);
  }

  @Delete('endpoints/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an endpoint; its events are kept' })
  async remove(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.inbound.remove(req.user.tenantId, id);
  }

  @Get('events')
  @ApiOperation({
    summary: 'Received deliveries, newest first',
    description:
      '`signatureValid: null` means the endpoint has no scheme — the event is recorded but unverified; `false` with `status: rejected` is a delivery the receiver refused.',
  })
  @ApiQuery({ name: 'endpointId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async events(
    @Request() req: AuthenticatedRequest,
    @Query('endpointId') endpointId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inbound.listEvents(
      req.user.tenantId,
      endpointId,
      limit ? parseInt(limit, 10) || 100 : 100,
    );
  }
}
