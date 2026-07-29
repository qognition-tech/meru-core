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
      'Creates the user in `invited` status with no usable password. No ' +
      'credential is returned — the invitee gets in via password reset or ' +
      'SSO. Email delivery is not wired yet; the row is created regardless.',
  })
  @ApiResponse({ status: 201, description: 'User invited' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async invite(
    @Request() req: AuthenticatedRequest,
    @Body() dto: InviteUserDto,
  ) {
    return this.iamService.inviteUser(req.user.tenantId, dto);
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
