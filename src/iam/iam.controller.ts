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
import { Public } from './decorators/public.decorator';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { VerifyMfaLoginDto, VerifyMfaSetupDto } from './dto/mfa.dto';

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

  // This is the "me" endpoint — every authenticated user must be able to read
  // their own profile. It was `@Roles('admin')`, a role no user has ever held,
  // so it returned 403 to everyone including admins; the portals worked around
  // it by hydrating the user off the login response. Authentication is the only
  // requirement here, so there is no @Roles at all.
  @Get('profile')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get the authenticated user’s own profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
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
  // Typed against the DTO class, not the CreateUserInput interface. Interfaces
  // are erased at runtime, so ValidationPipe had no metadata to validate and an
  // empty body passed straight through to the service — where TypeORM silently
  // drops `where: { email: undefined }` and matched the first user in the table,
  // reporting "Email already registered" for a request containing nothing.
  async register(@Body() createUserDto: CreateUserDto) {
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

  // ── Multi-factor authentication ───────────────────────────────────────────
  //
  // None of these were routed. `login()` has always been able to answer
  // `requiresMfa: true`, but with no endpoint to complete the challenge that
  // response was a dead end — enabling MFA locked the user out permanently.

  @Post('mfa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete an MFA login',
    description:
      'Second leg of the login flow. Exchanges the short-lived ' +
      '`temporaryToken` from POST /auth/login plus a TOTP code for a full ' +
      'token pair. Returns the same payload shape as POST /auth/login.',
  })
  @ApiResponse({ status: 200, description: 'MFA accepted — tokens issued' })
  @ApiResponse({ status: 400, description: 'MFA not configured for this user' })
  @ApiResponse({
    status: 401,
    description: 'Invalid code, or expired challenge',
  })
  async verifyMfaLogin(@Body() dto: VerifyMfaLoginDto) {
    return this.iamService.verifyMfaLogin(dto.temporaryToken, dto.token);
  }

  @Post('mfa/setup')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Begin TOTP enrolment for the authenticated user',
    description:
      'Generates a secret and returns it with a QR code. MFA is not active ' +
      'until POST /auth/mfa/setup/verify confirms a code from the authenticator.',
  })
  @ApiResponse({ status: 200, description: 'Secret and QR code returned' })
  @ApiResponse({ status: 400, description: 'MFA is already enabled' })
  async setupMfa(@Request() req) {
    return this.iamService.setupMfa(req.user.id);
  }

  @Post('mfa/setup/verify')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Confirm TOTP enrolment and switch MFA on' })
  @ApiResponse({ status: 200, description: 'MFA enabled' })
  @ApiResponse({ status: 400, description: 'Invalid verification code' })
  async verifyMfaSetup(@Request() req, @Body() dto: VerifyMfaSetupDto) {
    return this.iamService.verifyMfaSetup(req.user.id, dto.token);
  }

  @Post('mfa/disable')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Turn MFA off for the authenticated user' })
  @ApiResponse({ status: 200, description: 'MFA disabled' })
  async disableMfa(@Request() req) {
    return this.iamService.disableMfa(req.user.id);
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
        SAMLResponse: {
          type: 'string',
          description: 'Base64-encoded SAMLResponse from IdP',
        },
        RelayState: { type: 'string' },
      },
      required: ['SAMLResponse'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'SAML login successful — JWT returned',
  })
  @ApiResponse({ status: 401, description: 'Invalid SAML assertion' })
  async samlCallback(
    @Body('SAMLResponse') samlResponse: string,
    @Body('RelayState') relayState: string,
  ) {
    return this.samlService.handleCallback(samlResponse, relayState ?? '');
  }
}
