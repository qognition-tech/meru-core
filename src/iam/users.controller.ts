import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IamService } from './iam.service';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { AuthenticatedRequest } from '../common/types';

/**
 * The tenant user directory.
 *
 * Every route is implicitly tenant-scoped: the tenant comes from the caller's
 * JWT, never from the request body or a query param, so there is no route
 * here through which one tenant can name another. RLS is the backstop — see
 * CLAUDE.md §6.4.
 */
@ApiTags('iam')
@Controller('iam/users')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(private readonly iamService: IamService) {}

  @Get()
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: "List the calling user's tenant directory",
    description:
      "Returns every user on the caller's tenant, newest first. Never " +
      'includes password or MFA material. `role` is the single primary role ' +
      'by precedence; `roles` is the full list.',
  })
  @ApiResponse({ status: 200, description: 'Directory retrieved' })
  @ApiResponse({ status: 403, description: 'Requires a tenant admin role' })
  async list(@Request() req: AuthenticatedRequest) {
    return this.iamService.listUsers(req.user.tenantId);
  }

  // Before `:id`, or Nest resolves `/directory` as `getUser('directory')` and
  // 400s on ParseUUIDPipe.
  @Get('directory')
  @Roles(
    PlatformRole.PLATFORM_ADMIN,
    PlatformRole.FIRM_ADMIN,
    PlatformRole.STAFF,
  )
  @ApiOperation({
    summary: 'Just the names — id, display name, primary role',
    description:
      'What an assignee picker and a comment author chip need, available to ' +
      '`staff`. `GET /iam/users` is `firm_admin`+ and stays that way: it ' +
      'carries email addresses, MFA state, invite status and last-login times. ' +
      'Without this route staff could not resolve the author of a file note, so ' +
      'the staff client page showed notes with no author.\n\n' +
      'A fixed narrow projection rather than `?fields=` — a field selector is ' +
      'one careless addition away from leaking what it was introduced to avoid.',
  })
  @ApiResponse({ status: 200, description: 'Names retrieved' })
  async directory(@Request() req: AuthenticatedRequest) {
    return this.iamService.listDirectoryNames(req.user.tenantId);
  }

  @Get(':id')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({ summary: 'Get a single directory user' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'User retrieved' })
  @ApiResponse({ status: 404, description: 'No such user on this tenant' })
  async get(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.iamService.getUser(req.user.tenantId, id);
  }

  @Post('invite')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite a user into the tenant',
    description:
      'Creates the user in `invited` status with no usable password and emails ' +
      'them a single-use acceptance link (7-day expiry) to set one. No ' +
      'credential is ever returned to the caller. `inviteSent` reports whether ' +
      'the email actually went out — when mail is unconfigured the link is ' +
      'only in the server log.',
  })
  @ApiResponse({ status: 201, description: 'User invited' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async invite(
    @Request() req: AuthenticatedRequest,
    @Body() dto: InviteUserDto,
  ) {
    return this.iamService.inviteUser(req.user.tenantId, dto, {
      id: req.user.id,
      name: req.user.email,
    });
  }

  @Post(':id/resend-invite')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-send a pending invitation',
    description:
      'Issues a fresh acceptance link and invalidates the previous one, so ' +
      'this also revokes a link that went to the wrong address. Only valid ' +
      'while the user is still `invited` — an accepted user should use ' +
      'password reset instead.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Invitation re-sent' })
  @ApiResponse({ status: 400, description: 'User has already accepted' })
  @ApiResponse({ status: 404, description: 'No such user on this tenant' })
  async resendInvite(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.iamService.resendInvite(req.user.tenantId, id, {
      id: req.user.id,
      name: req.user.email,
    });
  }

  @Patch(':id')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: 'Update a directory user (partial)',
    description:
      'Cannot change email, password, tenant or MFA state — those fields are ' +
      'rejected outright, so this route can never be used for account takeover.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'User updated' })
  @ApiResponse({ status: 404, description: 'No such user on this tenant' })
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.iamService.updateUser(req.user.tenantId, id, dto);
  }

  // PATCH is the canonical verb — omitted fields are left alone. PUT is kept as
  // an alias because the portals were written against it before this route
  // existed, and breaking three deployed frontends over a verb is not worth it.
  //
  // It must be a *separate handler*: stacking `@Put()` and `@Patch()` on one
  // method does not register both. Both decorators write the same `method`
  // metadata key, so the second silently overwrites the first and only one verb
  // is ever routed — `PATCH` returned "Cannot PATCH /iam/users/:id" until this
  // was split.
  @Put(':id')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({ summary: 'Update a directory user (alias of PATCH)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'User updated' })
  @ApiResponse({ status: 404, description: 'No such user on this tenant' })
  async replace(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.update(req, id, dto);
  }
}
