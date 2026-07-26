import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { IamService } from './iam.service';
import { SamlService } from './services/saml.service';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { Public } from './decorators/public.decorator';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import type { CreateUserInput } from '../common/types';

@Controller('auth')
@ApiTags('auth')
export class IamController {
  constructor(
    private iamService: IamService,
    private samlService: SamlService,
  ) {}

  @Post('login')
  @UseGuards(AuthGuard('local')) // See ./strategies/local.strategy.ts
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', example: 'user@example.com' },
        password: { type: 'string', example: 'password123' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async login(@Request() req) {
    return this.iamService.login(req.user);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  getProfile(@Request() req) {
    return req.user;
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tenantSlug: { type: 'string', example: 'acme-immigration' },
        email: { type: 'string', example: 'user@example.com' },
        password: { type: 'string', example: 'password123' },
      },
      required: ['tenantSlug', 'email', 'password'],
    },
  })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async register(@Body() createUserDto: CreateUserInput) {
    return this.iamService.register(createUserDto);
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange an opaque refresh token for a new token pair',
    description:
      'Validates the refresh token against its active session, revokes that ' +
      'session (rotation), and issues a fresh access/refresh pair. Returns ' +
      'the same payload shape as POST /auth/login.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        refresh_token: { type: 'string', example: 'e3b0c44298fc1c14…' },
      },
      required: ['refresh_token'],
    },
  })
  @ApiResponse({ status: 200, description: 'Tokens refreshed successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.iamService.refreshTokens(refreshTokenDto.refresh_token);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke the session behind a refresh token',
    description:
      'Revokes the single session identified by the supplied refresh token. ' +
      'Idempotent — an unknown or already-revoked token still returns 200 so ' +
      'clients can always clear stale credentials.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        refresh_token: { type: 'string', example: 'e3b0c44298fc1c14…' },
      },
      required: ['refresh_token'],
    },
  })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async logout(@Body() logoutDto: LogoutDto) {
    return this.iamService.logoutSession(logoutDto.refresh_token);
  }

  // ── SAML SSO endpoints ────────────────────────────────────────────────────

  @Get('saml/initiate')
  @ApiOperation({
    summary: 'Initiate SAML SSO — redirects to the tenant IdP',
    description:
      'Generates a SAML AuthnRequest and redirects the browser to the ' +
      'configured Identity Provider. Requires ssoConfig.provider=saml and ' +
      'ssoConfig.entryPoint to be set on the tenant.',
  })
  @ApiQuery({ name: 'tenantSlug', required: true, example: 'acme-banking' })
  @ApiResponse({ status: 302, description: 'Redirect to IdP' })
  @ApiResponse({ status: 400, description: 'Tenant not configured for SAML' })
  async samlInitiate(
    @Query('tenantSlug') tenantSlug: string,
    @Res() res: Response,
  ) {
    const { redirectUrl } = await this.samlService.initiateLogin(tenantSlug);
    return res.redirect(HttpStatus.FOUND, redirectUrl);
  }

  @Post('saml/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SAML SSO callback — receives assertion from IdP',
    description:
      'The IdP POSTs the SAMLResponse here after authentication. ' +
      'Validates the assertion and returns a Meru JWT access token on success.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        SAMLResponse: { type: 'string', description: 'Base64-encoded SAMLResponse from IdP' },
        RelayState: { type: 'string' },
      },
      required: ['SAMLResponse'],
    },
  })
  @ApiResponse({ status: 200, description: 'SAML login successful — JWT returned' })
  @ApiResponse({ status: 401, description: 'Invalid SAML assertion' })
  async samlCallback(
    @Body('SAMLResponse') samlResponse: string,
    @Body('RelayState') relayState: string,
  ) {
    return this.samlService.handleCallback(samlResponse, relayState ?? '');
  }
}
