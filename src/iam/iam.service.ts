import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
// IsNull() is mandatory for "column IS NULL" in find options. A bare
// `revokedAt: null` is NOT an error and NOT a null comparison — TypeORM 0.3
// treats it like `undefined` and drops the condition from the WHERE clause
// entirely. Every revocation check in this file was written that way (and cast
// with `as any`, which hid the type error that would have caught it), so
// `revokedAt` was never actually tested: revoked sessions still refreshed and
// revoked API keys still authenticated. Verified against the generated SQL.
import { IsNull, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User, AuthProvider, UserStatus } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthToken, AuthTokenType } from './entities/auth-token.entity';
import { UserPayload, DirectoryUser } from '../common/types';
import { TenantContext } from '../core/tenancy/tenant-context';
import {
  PlatformRole,
  ROLE_PRECEDENCE,
  canGrantRole,
} from './enums/platform-role.enum';
import type { Actor } from '../common/access';
import { MailService } from '../core/mail/mail.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
// otplib is pinned to v12 deliberately. v13 pulls in @scure/base and
// @noble/hashes, which are ESM-only; Vercel's serverless loader cannot
// require() an ES module at all, so merely importing this file crashed the
// function on every request with ERR_REQUIRE_ESM. v12's tree (thirty-two +
// node:crypto) is plain CommonJS. See scripts/check-cjs-deps.js.
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

/**
 * Where a sign-in came from.
 *
 * Recorded on the session so a user can tell their three portals apart in the
 * session list — ImmiStack on a laptop and GovernanceX on a phone are two
 * legitimate concurrent sessions, and they have to be distinguishable before
 * "revoke that one" means anything.
 */
export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
  /** Which product opened it: `immistack`, `meru-dashboard`, `governancex`. */
  client?: string;
}

@Injectable()
export class IamService {
  private readonly logger = new Logger(IamService.name);
  private readonly REFRESH_TOKEN_TTL_DAYS = 30;
  private readonly PASSWORD_RESET_TTL_MINUTES = 60;
  private readonly INVITE_TTL_DAYS = 7;
  private readonly API_KEY_PREFIX = 'meru_';

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Tenant) private tenantRepo: Repository<Tenant>,
    @InjectRepository(Role) private roleRepo: Repository<Role>,
    @InjectRepository(Session) private sessionRepo: Repository<Session>,
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(AuthToken)
    private authTokenRepo: Repository<AuthToken>,
    private jwtService: JwtService,
    private mailService: MailService,
  ) {}

  // ─── Authentication ──────────────────────────────────────────────

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserPayload | null> {
    // Bootstrap lookup: the tenant is what this query *discovers*, so there is
    // no tenant bound yet and RLS would filter the row away. See
    // TenantContext.runAsSystem — scoped to this one query on purpose.
    const user = await TenantContext.runAsSystem(
      'resolve user by email during login',
      () =>
        this.userRepo.findOne({
          where: { email },
          relations: ['tenant'],
          select: [
            'id',
            'email',
            'password',
            'tenantId',
            'status',
            'mfaEnabled',
            'roles',
          ],
        }),
    );

    if (
      !user ||
      user.status === UserStatus.LOCKED ||
      user.status === UserStatus.INACTIVE
    ) {
      return null;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
      mfaEnabled: user.mfaEnabled,
    };
  }

  async login(user: UserPayload, context: SessionContext = {}) {
    // If MFA is enabled but not yet verified, return temporary token
    if (user.mfaEnabled) {
      return {
        requiresMfa: true,
        userId: user.id,
        temporaryToken: this.jwtService.sign(
          { sub: user.id, mfaPending: true },
          { expiresIn: '5m' },
        ),
      };
    }

    // Login is a public route, so TenantBindingInterceptor has nothing to bind
    // from: the tenant only becomes known once validateUser() has run. Bind it
    // here so the session writes below execute against the right tenant instead
    // of an unbound (zero-row) connection.
    TenantContext.setTenantId(user.tenantId);

    // Concurrent sessions are allowed. This used to revoke every other active
    // session on each login, but the `revokedAt` predicate was silently dropped
    // (see the IsNull import note) so it never actually took effect. Now that
    // the predicate works, reinstating it would mean signing into ImmiStack
    // silently signs you out of the Meru Dashboard and GovernanceX — one user
    // legitimately uses several portals against this one API at the same time,
    // and on separate devices.
    //
    // Explicit revocation is still available and now genuinely works:
    // `logoutSession(refreshToken)` drops one session, `logout(userId)` drops
    // all of them, and refresh tokens are single-use (see refreshTokens).

    const tokens = await this.issueSession(user, context);

    // Enrich the response with the user profile + tenant so front-end portals
    // (Meru Dashboard / ImmiStack / GovernanceX) can hydrate their auth store
    // without a second round-trip.
    return {
      ...tokens,
      tenant_id: user.tenantId,
      user: await this.buildAuthUser(user),
    };
  }

  /**
   * Builds the client-facing user object returned by login. Maps the internal
   * User entity / UserPayload onto the shape the front-end auth stores expect
   * ({ id, tenant_id, email, role, permissions, profile }).
   */
  private async buildAuthUser(payload: UserPayload) {
    const user = await this.userRepo.findOne({
      where: { id: payload.id },
    });

    const roles = payload.roles ?? [];

    return {
      id: payload.id,
      tenant_id: payload.tenantId,
      email: payload.email,
      role: this.resolvePrimaryRole(roles),
      permissions: roles,
      profile: {
        first_name: user?.firstName ?? '',
        last_name: user?.lastName ?? '',
        avatar_url: user?.avatarUrl ?? undefined,
        title: undefined,
      },
    };
  }

  /**
   * Collapses the user's role list into the single primary role the portals
   * switch on. Prefers the most-privileged known platform role when present.
   */
  private resolvePrimaryRole(roles: string[]): string {
    for (const role of ROLE_PRECEDENCE) {
      if (roles.includes(role)) return role;
    }
    // A user holding only unknown roles gets the least-privileged default
    // rather than their first arbitrary role — the portals switch on this
    // value, and an unrecognised one routes nowhere.
    return PlatformRole.STAFF;
  }

  async refreshTokens(refreshToken: string, context: SessionContext = {}) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Bootstrap lookup: an opaque refresh token carries no tenant, so this
    // query is what establishes identity. Scoped to the lookup only — the
    // session/token writes below run tenant-bound.
    const session = await TenantContext.runAsSystem(
      'resolve session by refresh token',
      () =>
        this.sessionRepo.findOne({
          where: { refreshTokenHash, revokedAt: IsNull() },
          relations: ['user'],
        }),
    );

    if (!session || new Date() > session.expiresAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = session.user;

    // As in login(): the tenant is only known once the token has been resolved,
    // so bind it before the session rotation writes below.
    TenantContext.setTenantId(user.tenantId);

    // Retire the old session with a conditional UPDATE rather than a read-then-
    // save. `revokedAt IS NULL` in the WHERE makes the rotation atomic: if two
    // requests present the same refresh token concurrently, exactly one gets
    // affected=1 and the loser is rejected instead of both being issued a fresh
    // token pair. A refresh token is single-use, and this is what enforces it.
    const revoked = await this.sessionRepo.update(
      { id: session.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (!revoked.affected) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
    };

    // The rotated session inherits the original's client/device identity when
    // the caller does not re-supply it, so a silent refresh does not turn one
    // device into an anonymous new entry in the user's session list.
    const tokens = await this.issueSession(payload, {
      ipAddress: context.ipAddress ?? session.ipAddress,
      userAgent: context.userAgent ?? session.userAgent,
      client: context.client ?? session.client ?? undefined,
    });

    // Mirror the login() payload so the front-end can re-hydrate its auth
    // store from a silent refresh without a second round-trip.
    return {
      ...tokens,
      tenant_id: payload.tenantId,
      user: await this.buildAuthUser(payload),
    };
  }

  /**
   * Revokes the single session identified by an opaque refresh token.
   * Idempotent — an unknown or already-revoked token is a no-op, so a client
   * clearing stale credentials never sees an error.
   */
  async logoutSession(refreshToken: string) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Same bootstrap case as refreshTokens(): logout is reachable with only an
    // opaque token, so the row has to be found before any tenant is known.
    await TenantContext.runAsSystem(
      'revoke session by refresh token',
      async () => {
        const session = await this.sessionRepo.findOne({
          where: { refreshTokenHash, revokedAt: IsNull() },
        });

        if (session) {
          session.revokedAt = new Date();
          await this.sessionRepo.save(session);
        }
      },
    );

    return { success: true };
  }

  async logout(userId: string) {
    // Revoke all active sessions
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
    });
    for (const s of activeSessions) {
      s.revokedAt = new Date();
    }
    if (activeSessions.length > 0) {
      await this.sessionRepo.save(activeSessions);
    }
    return { success: true };
  }

  // ─── MFA ──────────────────────────────────────────────────────────

  async setupMfa(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled');
    }

    const secret = authenticator.generateSecret();
    user.mfaSecret = secret;
    await this.userRepo.save(user);

    const otpauthUrl = authenticator.keyuri(
      user.email,
      'Meru Platform',
      secret,
    );
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    return { secret, qrCode, otpauthUrl };
  }

  async verifyMfaSetup(userId: string, token: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'mfaSecret', 'mfaEnabled'],
    });

    if (!user || !user.mfaSecret)
      throw new NotFoundException('MFA not initialized');

    const isValid = authenticator.check(token, user.mfaSecret);
    if (!isValid) throw new BadRequestException('Invalid verification code');

    user.mfaEnabled = true;
    await this.userRepo.save(user);
    return { success: true };
  }

  /**
   * Second leg of an MFA login.
   *
   * Takes the `temporaryToken` issued by `login()`, **not** a bare user id. The
   * temporary token is what proves the password leg already succeeded; keying
   * this off an id supplied by the caller would let anyone skip the password
   * entirely and brute-force a six-digit code against any account they could
   * name. The token is single-purpose (`mfaPending`) and expires in 5 minutes.
   */
  async verifyMfaLogin(
    temporaryToken: string,
    token: string,
    context: SessionContext = {},
  ) {
    let challenge: { sub?: string; mfaPending?: boolean };
    try {
      challenge = this.jwtService.verify(temporaryToken);
    } catch {
      throw new UnauthorizedException('MFA challenge is invalid or expired');
    }

    // An ordinary access token must not be accepted here — it would turn this
    // route into a way to mint a full session from a half-scoped credential.
    if (!challenge?.mfaPending || !challenge.sub) {
      throw new UnauthorizedException('MFA challenge is invalid or expired');
    }

    // Bootstrap lookup, same as login(): the tenant is what this resolves, so
    // there is nothing bound yet and RLS would filter the row away.
    const user = await TenantContext.runAsSystem(
      'resolve user for MFA challenge',
      () =>
        this.userRepo.findOne({
          where: { id: challenge.sub },
          select: [
            'id',
            'email',
            'tenantId',
            'mfaSecret',
            'mfaEnabled',
            'roles',
          ],
        }),
    );

    if (!user || !user.mfaSecret || !user.mfaEnabled) {
      throw new BadRequestException('MFA not configured');
    }

    const isValid = authenticator.check(token, user.mfaSecret);
    if (!isValid) throw new UnauthorizedException('Invalid MFA token');

    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
    };

    // Bind before the session/stat writes below, as login() does.
    TenantContext.setTenantId(user.tenantId);

    const tokens = await this.issueSession(payload, context);

    await this.userRepo.increment({ id: user.id }, 'loginCount', 1);
    await this.userRepo.update(user.id, { lastLoginAt: new Date() });

    // Same envelope as login() so the portals hydrate their auth store
    // identically whichever leg completed the sign-in.
    return {
      ...tokens,
      tenant_id: payload.tenantId,
      user: await this.buildAuthUser(payload),
    };
  }

  async disableMfa(userId: string) {
    await this.userRepo.update(userId, {
      mfaEnabled: false,
      mfaSecret: null as any,
    });
    return { success: true };
  }

  // ─── RBAC / Role Management ──────────────────────────────────────

  async getRoles(tenantId: string) {
    return this.roleRepo.find({ where: { tenantId } });
  }

  async createRole(
    tenantId: string,
    name: string,
    permissions: string[],
    description?: string,
  ) {
    const existing = await this.roleRepo.findOne({ where: { tenantId, name } });
    if (existing) throw new ConflictException('Role already exists');

    return this.roleRepo.save(
      this.roleRepo.create({
        tenantId,
        name,
        permissions,
        description,
        isSystem: false,
      }),
    );
  }

  async updateRolePermissions(roleId: string, permissions: string[]) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    role.permissions = permissions;
    return this.roleRepo.save(role);
  }

  async deleteRole(roleId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem)
      throw new BadRequestException('Cannot delete system roles');
    return this.roleRepo.remove(role);
  }

  // ─── API Key Management ──────────────────────────────────────────

  // ── API keys — DEAD CODE, see api-key.entity.ts ──────────────────────────
  // No route calls createApiKey/listApiKeys/revokeApiKey and no strategy or
  // guard calls validateApiKey. Left in place until the api_keys table is
  // dropped by migration; do not expose these without building the guard.
  async createApiKey(
    userId: string,
    tenantId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ) {
    const rawKey = this.API_KEY_PREFIX + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.slice(0, 12);

    const apiKey = this.apiKeyRepo.create({
      tenantId,
      name,
      keyHash,
      prefix,
      scopes,
      expiresAt,
      createdBy: userId,
    });

    const saved = await this.apiKeyRepo.save(apiKey);

    return {
      id: saved.id,
      name: saved.name,
      key: `meru_${saved.id.slice(0, 8)}_${rawKey}`,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt,
    };
  }

  async listApiKeys(tenantId: string) {
    return this.apiKeyRepo.find({
      where: { tenantId, revokedAt: IsNull() },
      select: [
        'id',
        'name',
        'scopes',
        'lastUsedAt',
        'createdAt',
        'expiresAt',
        'prefix',
      ],
    });
  }

  async revokeApiKey(keyId: string) {
    await this.apiKeyRepo.update(keyId, { revokedAt: new Date() });
    return { success: true };
  }

  async validateApiKey(rawKey: string): Promise<UserPayload | null> {
    // Extract the hash-able portion
    const parts = rawKey.split('_');
    if (parts.length < 3) return null;

    const keyMaterial = parts.slice(2).join('_');
    const keyHash = crypto
      .createHash('sha256')
      .update(keyMaterial)
      .digest('hex');

    // Bootstrap lookup: an API key is presented before any tenant is known —
    // validating it is what determines the tenant.
    const apiKey = await TenantContext.runAsSystem(
      'validate API key hash',
      () =>
        this.apiKeyRepo.findOne({
          where: { keyHash, revokedAt: IsNull() },
          relations: ['creator'],
        }),
    );

    if (!apiKey) return null;
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) return null;

    // Still pre-authentication, so this write also needs the system context.
    await TenantContext.runAsSystem('stamp API key last-used', () =>
      this.apiKeyRepo.update(apiKey.id, { lastUsedAt: new Date() }),
    );

    const user = apiKey.creator;
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
      apiKeyId: apiKey.id,
    };
  }

  // ─── User Profile & Password ─────────────────────────────────────

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['tenant'],
    });
    if (!user) throw new NotFoundException('User not found');

    const { password, mfaSecret, ...profile } = user;
    return profile;
  }

  async updateProfile(
    userId: string,
    updates: Partial<
      Pick<
        User,
        | 'firstName'
        | 'lastName'
        | 'avatarUrl'
        | 'phone'
        | 'timezone'
        | 'preferences'
      >
    >,
  ) {
    await this.userRepo.update(userId, updates);
    return this.getProfile(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'password'],
    });

    if (!user) throw new NotFoundException('User not found');
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    user.password = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(user);

    // Revoke all existing sessions for security
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
    });
    for (const s of activeSessions) {
      s.revokedAt = new Date();
    }
    if (activeSessions.length > 0) {
      await this.sessionRepo.save(activeSessions);
    }

    return { success: true };
  }

  // ─── Tenant User Management ──────────────────────────────────────

  /**
   * The tenant's user directory.
   *
   * Returns a stable shape rather than raw entities: the portals render a
   * single primary role, and `roles` is a simple-array column that would
   * otherwise leak as a comma-joined string.
   */
  async listUsers(tenantId: string): Promise<DirectoryUser[]> {
    const users = await this.userRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });

    return users.map((u) => this.toDirectoryUser(u));
  }

  /**
   * The names behind the ids, for staff.
   *
   * `listUsers` is `firm_admin`+, which is right — it carries email addresses,
   * MFA state, invite status and last-login times. But it meant the `staff` role
   * could not resolve the author of a comment or choose an assignee, so the staff
   * client page rendered file notes with no author at all.
   *
   * A deliberately narrow projection rather than `?fields=` on the full route: a
   * field selector is one careless addition away from leaking the thing it was
   * introduced to avoid, and there is no request here that wants "some of the
   * sensitive fields". Id, display name and primary role are what a mention
   * chip and an assignee picker need, and nothing else is returned.
   */
  async listDirectoryNames(
    tenantId: string,
  ): Promise<Array<{ id: string; name: string; role: string | null }>> {
    const users = await this.userRepo.find({
      where: { tenantId },
      select: ['id', 'firstName', 'lastName', 'roles'],
      order: { createdAt: 'DESC' },
    });

    return users.map((u) => ({
      id: u.id,
      // Falls back to something rather than an empty chip: a comment attributed
      // to "" reads as a rendering fault.
      name:
        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
        'Unnamed user',
      role: (u.roles ?? [])[0] ?? null,
    }));
  }

  async getUser(tenantId: string, userId: string): Promise<DirectoryUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.toDirectoryUser(user);
  }

  /**
   * Invite a user into the tenant.
   *
   * The generated password is a placeholder so the row satisfies the NOT NULL
   * password column — it is never returned. This previously handed the
   * plaintext temp password back to any caller, which meant anyone who could
   * invite could also immediately authenticate as the invitee. The invitee
   * gets in via a password reset, or via SSO once that is wired.
   *
   * Note on uniqueness: `users.email` is globally unique by design, not per
   * tenant, because `validateUser()` resolves a login by email alone with no
   * tenant hint. Scoping this check per tenant would make logins ambiguous, so
   * the global check stays — only the error message is clearer.
   *
   * `actorRoles` is required, not optional, on purpose: `POST
   * /iam/users/invite` is reachable by `firm_admin`, and `InviteUserDto.role`
   * validates only `@IsEnum(PlatformRole)` — which accepts `platform_admin`.
   * Without a ceiling check here, any `firm_admin` could invite themselves a
   * `platform_admin` colleague and hand them God View. Checked before the
   * uniqueness lookup so a caller cannot even discover whether a
   * `platform_admin` email is taken.
   */
  async inviteUser(
    tenantId: string,
    dto: {
      email: string;
      role?: string;
      firstName?: string;
      lastName?: string;
      department?: string;
    },
    invitedBy: { id: string; name: string } | undefined,
    actorRoles: string[],
  ): Promise<DirectoryUser & { inviteSent: boolean }> {
    const requestedRole = dto.role ?? PlatformRole.STAFF;
    if (!canGrantRole(actorRoles, requestedRole)) {
      throw new ForbiddenException(
        `Cannot invite a user as '${requestedRole}': outranks the caller`,
      );
    }

    const existing = await TenantContext.runAsSystem(
      'check global email uniqueness before invite',
      () => this.userRepo.findOne({ where: { email: dto.email } }),
    );

    if (existing) {
      throw new ConflictException(
        existing.tenantId === tenantId
          ? 'A user with that email already exists in this tenant'
          : 'That email is already registered on the platform',
      );
    }

    // Unusable by construction: never returned, never sent anywhere. It exists
    // only because `password` is NOT NULL.
    const placeholderPassword = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      10,
    );

    const user = this.userRepo.create({
      email: dto.email,
      password: placeholderPassword,
      tenantId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      status: UserStatus.INVITED,
      provider: AuthProvider.LOCAL,
      roles: [requestedRole],
      attributes: dto.department ? { department: dto.department } : {},
    });

    await this.userRepo.save(user);

    // Issue the acceptance link. Without this the invite is a dead end: the
    // placeholder password above is unusable by construction and is never
    // returned, so an invited user previously had no route in at all.
    const { token, expiresAt } = await this.issueAuthToken(
      user,
      AuthTokenType.INVITE,
      this.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      invitedBy?.id,
    );

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    const { delivered } = await this.mailService.sendInvite({
      to: user.email,
      inviterName: invitedBy?.name ?? 'A colleague',
      tenantName: tenant?.name ?? 'your workspace',
      token,
      expiresAt,
    });

    // Reported rather than assumed. The user exists either way, but an admin
    // needs to know whether to expect the invitee to receive anything — when
    // mail is unconfigured the link is only in the server log.
    this.logger.log(
      `Invited ${dto.email} to tenant ${tenantId} (email delivered: ${delivered})`,
    );

    return { ...this.toDirectoryUser(user), inviteSent: delivered };
  }

  /**
   * Re-send an invitation, issuing a fresh link.
   *
   * Needed because delivery genuinely fails — SES misconfigured, a typo'd
   * address, a mailbox that bounced. Without this the only recovery was to
   * delete the user and invite them again, and `users.email` is globally
   * unique so that is not even reliably possible. Issuing a new token
   * invalidates the previous one, so a resend also revokes a link sent to the
   * wrong place.
   */
  async resendInvite(
    tenantId: string,
    userId: string,
    invitedBy?: { id: string; name: string },
  ): Promise<{ email: string; inviteSent: boolean; expiresAt: Date }> {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    // Only pending invitations. Re-inviting an active user would be a way to
    // force a password-set link onto somebody who already has credentials.
    if (user.status !== UserStatus.INVITED) {
      throw new BadRequestException(
        'That user has already accepted their invitation. Use password reset instead.',
      );
    }

    const { token, expiresAt } = await this.issueAuthToken(
      user,
      AuthTokenType.INVITE,
      this.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      invitedBy?.id,
    );

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    const { delivered } = await this.mailService.sendInvite({
      to: user.email,
      inviterName: invitedBy?.name ?? 'A colleague',
      tenantName: tenant?.name ?? 'your workspace',
      token,
      expiresAt,
    });

    this.logger.log(`Re-invited ${user.email} (email delivered: ${delivered})`);

    return { email: user.email, inviteSent: delivered, expiresAt };
  }

  /**
   * Update a directory user. Deliberately narrow — this cannot touch password,
   * email, tenantId or MFA state, so it can never be used for takeover.
   *
   * Two callers reach this, with different rights:
   *
   * - `platform_admin` / `firm_admin` managing someone else's row (or their
   *   own) — full directory management, including `role` and `status`.
   * - anyone else, but ONLY on their own `userId`. `PATCH /iam/users/:id` has
   *   no `@Roles` guard at all, on purpose — every portal's `ProfileView`
   *   calls this route against the caller's own id, and a plain `staff` or
   *   `client` user previously got a flat 403 editing their own name. That
   *   authorisation decision ("is this my own row") belongs here, not on the
   *   controller, the same as `own` scope elsewhere in this codebase. A
   *   non-admin self-caller may change `firstName` / `lastName` /
   *   `department` only: `role` and `status` are refused even on their own
   *   row, because those are privilege and account-standing fields, not
   *   profile fields.
   *
   * `role` is additionally ceiling-checked for EVERY caller via
   * `canGrantRole`, admin or not, self or not — this is what stops a
   * `firm_admin` from PATCHing their own id to `platform_admin`. The old
   * `@Roles(PLATFORM_ADMIN, FIRM_ADMIN)` guard admitted `firm_admin`, and
   * nothing before this checked the requested role against the caller's own.
   */
  async updateUser(
    tenantId: string,
    userId: string,
    updates: {
      firstName?: string;
      lastName?: string;
      role?: string;
      department?: string;
      status?: UserStatus;
    },
    actor: Actor,
  ): Promise<DirectoryUser> {
    const isSelf = actor.id === userId;
    const isAdmin = actor.roles.some(
      (r) =>
        r === PlatformRole.PLATFORM_ADMIN || r === PlatformRole.FIRM_ADMIN,
    );

    if (!isAdmin && !isSelf) {
      // Stands in for the removed `@Roles(PLATFORM_ADMIN, FIRM_ADMIN)` guard
      // for every case except "editing my own row" — a plain staff or client
      // caller still cannot reach anyone else's user record through here.
      throw new ForbiddenException('You can only update your own profile');
    }

    if (
      !isAdmin &&
      (updates.role !== undefined || updates.status !== undefined)
    ) {
      throw new ForbiddenException('You cannot change your own role or status');
    }

    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (
      updates.role !== undefined &&
      !canGrantRole(actor.roles, updates.role)
    ) {
      throw new ForbiddenException(
        `Cannot grant role '${updates.role}': outranks the caller`,
      );
    }

    if (updates.firstName !== undefined) user.firstName = updates.firstName;
    if (updates.lastName !== undefined) user.lastName = updates.lastName;
    if (updates.status !== undefined) user.status = updates.status;
    if (updates.role !== undefined) user.roles = [updates.role];
    if (updates.department !== undefined) {
      user.attributes = { ...user.attributes, department: updates.department };
    }

    await this.userRepo.save(user);
    return this.toDirectoryUser(user);
  }

  private toDirectoryUser(user: User): DirectoryUser {
    const roles = user.roles ?? [];
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      name,
      role: this.resolvePrimaryRole(roles),
      roles,
      department: (user.attributes?.department as string) ?? null,
      status: user.status,
      lastActiveAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      avatarUrl: user.avatarUrl ?? null,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  // `generateTokens` was folded into `issueSession`. Signing the access token
  // separately from creating the session meant the token could not carry the
  // session's id, so nothing could map a live token back to the row that
  // authorises it — which is what "revoke this one device" requires.

  private async createSession(
    user: UserPayload,
    refreshToken: string,
    context: SessionContext = {},
  ) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const session = this.sessionRepo.create({
      userId: user.id,
      tenantId: user.tenantId,
      // Both columns hold the same digest. `tokenHash` carries the UNIQUE
      // constraint, which is what makes a refresh token unrepeatable;
      // `refreshTokenHash` is what lookups filter on.
      tokenHash: refreshTokenHash,
      refreshTokenHash,
      // Recorded rather than blank. These were hardcoded to '', so the columns
      // existed but never held anything — there was no way to tell a user which
      // devices held a live session, let alone let them revoke one.
      ipAddress: context.ipAddress ?? '',
      userAgent: context.userAgent ?? '',
      client: context.client ?? null,
      expiresAt: new Date(
        Date.now() + this.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    });

    return this.sessionRepo.save(session);
  }

  // ─── Credential Recovery ─────────────────────────────────────────
  //
  // Password reset and invite acceptance share one mechanism: a single-use,
  // time-limited token whose SHA-256 is all that is stored. The two differ only
  // in lifetime and in the email that carries them.

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Mint a credential token and persist only its digest.
   *
   * Any unused token of the same type for that user is burned first, so a
   * second "forgot password" click invalidates the first link rather than
   * leaving two live ways into the account.
   */
  private async issueAuthToken(
    user: User,
    type: AuthTokenType,
    ttlMs: number,
    issuedBy?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.authTokenRepo.update(
      { userId: user.id, type, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    await this.authTokenRepo.save(
      this.authTokenRepo.create({
        tenantId: user.tenantId,
        userId: user.id,
        type,
        tokenHash: this.hashToken(token),
        expiresAt,
        issuedBy: issuedBy ?? null,
      }),
    );

    return { token, expiresAt };
  }

  /**
   * Begin a password reset.
   *
   * Always resolves the same way regardless of whether the address exists.
   * Reporting "no such user" would turn this endpoint into a free membership
   * oracle for anyone with a list of email addresses, and the response is
   * public. The work is identical either way; only the email differs.
   */
  async requestPasswordReset(email: string): Promise<{ ok: true }> {
    // Bootstrap lookup: an unauthenticated caller supplies only an email, so
    // the tenant is what this discovers.
    const user = await TenantContext.runAsSystem(
      'resolve user by email for password reset',
      () => this.userRepo.findOne({ where: { email } }),
    );

    if (!user) {
      this.logger.log(`Password reset requested for unknown address ${email}`);
      return { ok: true };
    }

    if (user.status === UserStatus.LOCKED) {
      // A locked account must not be recoverable by self-service; that is the
      // point of locking it.
      this.logger.warn(`Password reset refused for locked account ${email}`);
      return { ok: true };
    }

    const { token, expiresAt } = await TenantContext.runAsSystem(
      'issue password reset token',
      () =>
        this.issueAuthToken(
          user,
          AuthTokenType.PASSWORD_RESET,
          this.PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
        ),
    );

    await this.mailService.sendPasswordReset({
      to: user.email,
      firstName: user.firstName,
      token,
      expiresAt,
    });

    return { ok: true };
  }

  /**
   * Redeem a reset or invite token and set a password.
   *
   * One handler for both types because the security-relevant steps are
   * identical. Every session the user holds is revoked afterwards: a password
   * change is the standard response to a suspected compromise, and leaving the
   * attacker's existing refresh token alive would defeat it.
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: true; email: string }> {
    const tokenHash = this.hashToken(token);

    // Whoever presents a reset link has no session, so nothing is bound and
    // RLS would filter the row away.
    return TenantContext.runAsSystem('redeem credential token', async () => {
      const record = await this.authTokenRepo.findOne({
        where: { tokenHash },
      });

      // Deliberately one message for missing, used and expired. Distinguishing
      // them tells an attacker probing tokens which guesses were once real.
      const invalid = new BadRequestException(
        'This link is invalid or has expired. Request a new one.',
      );

      if (!record || record.usedAt || record.expiresAt < new Date()) {
        throw invalid;
      }

      const user = await this.userRepo.findOne({
        where: { id: record.userId },
      });
      if (!user) throw invalid;

      // Burn the token first. If the password write fails afterwards the link
      // is still spent, which is the safe direction to fail in.
      const burned = await this.authTokenRepo.update(
        { id: record.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );

      // Lost the race with a concurrent redemption of the same link.
      if (!burned.affected) throw invalid;

      user.password = await bcrypt.hash(newPassword, 10);

      // An invited user becomes active by accepting; a reset leaves status be.
      if (user.status === UserStatus.INVITED) {
        user.status = UserStatus.ACTIVE;
      }

      await this.userRepo.save(user);

      await this.sessionRepo.update(
        { userId: user.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );

      this.logger.log(`Password set for ${user.email} via ${record.type}`);

      return { ok: true as const, email: user.email };
    });
  }

  // ─── Session Management ──────────────────────────────────────────
  //
  // ImmiStack, the Meru Dashboard and GovernanceX are three separate products
  // that one person legitimately holds open at once, on more than one device.
  // So concurrent sessions are allowed by design — but "allowed" is only safe
  // if they are also *visible* and individually revocable, which is what this
  // section provides. A blanket revoke-on-login would have been simpler and
  // wrong: it would silently sign you out of the other two products.

  /**
   * Issue a token pair and the session behind it.
   *
   * The session row is created *before* the access token is signed so the
   * token can carry its `sid`. Without that link an access token cannot be
   * traced to a session, and "which of these is the device I'm on right now?"
   * is unanswerable.
   */
  private async issueSession(user: UserPayload, context: SessionContext = {}) {
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const session = await this.createSession(user, refreshToken, context);

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles,
      // `role` (singular) as well as `roles`. The portals decode this token in
      // Next.js middleware to pick a portal and gate the /platform, /admin,
      // /staff and /client prefixes, and they read `payload.role` — with only
      // `roles` present that guard silently passed everything through.
      // Authorisation on the server never uses this claim; PolicyGuard reads
      // `roles` off the validated user.
      role: this.resolvePrimaryRole(user.roles ?? []),
      sid: session.id,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600, // 1 hour
      token_type: 'Bearer',
    };
  }

  /**
   * Mint a short-lived token that lets a platform operator act inside another
   * tenant, for support ("the firm says this case will not open").
   *
   * Deliberately NOT `issueSession`, in three ways:
   *
   * - **No refresh token.** Impersonation must expire on its own. A refresh
   *   token would let a support session outlive the incident it was opened
   *   for, and nothing would show it was still alive.
   * - **No session row.** The impersonated user's own device list is theirs;
   *   an operator's support session appearing in it invites them to revoke
   *   something they do not understand, and makes "sessions" mean two things.
   * - **15 minutes, not an hour.** Long enough to diagnose, short enough that
   *   a forgotten browser tab is not standing access to a customer's data.
   *
   * The `imp` claim rides along so every action taken with this token names
   * the operator behind it. Caller MUST wrap this in `TenancyService.runAsGod`
   * — the user lookup below crosses a tenant boundary, and an unaudited
   * impersonation is exactly the thing CLAUDE.md §6.4 forbids.
   */
  async issueImpersonationToken(
    targetTenantId: string,
    operator: { id: string; tenantId: string },
  ): Promise<{
    access_token: string;
    expires_in: number;
    token_type: string;
    impersonating: { userId: string; email: string; tenantId: string };
  }> {
    // `roles` is a simple-array column on the user, not a relation — no
    // `relations: ['roles']` here, which would throw at query time.
    const target = await this.userRepo.findOne({
      where: { tenantId: targetTenantId, status: UserStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });

    if (!target) {
      throw new BadRequestException(
        `Tenant ${targetTenantId} has no active user to impersonate`,
      );
    }

    const roles = target.roles ?? [];

    const accessToken = this.jwtService.sign(
      {
        sub: target.id,
        email: target.email,
        tenantId: target.tenantId,
        roles,
        role: this.resolvePrimaryRole(roles),
        imp: { operatorId: operator.id, operatorTenantId: operator.tenantId },
      },
      { expiresIn: '15m' },
    );

    return {
      access_token: accessToken,
      expires_in: 900,
      token_type: 'Bearer',
      impersonating: {
        userId: target.id,
        email: target.email,
        tenantId: target.tenantId,
      },
    };
  }

  /**
   * The caller's own active sessions, newest first.
   *
   * Scoped to `userId` from the validated JWT — there is no parameter here a
   * caller could point at somebody else. Returns no token material of any
   * kind; a session is identified to the client only by its row id.
   */
  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const now = Date.now();

    return sessions
      .filter((s) => s.expiresAt.getTime() > now)
      .map((s) => ({
        id: s.id,
        client: s.client ?? 'unknown',
        ipAddress: s.ipAddress || null,
        userAgent: s.userAgent || null,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        /** True for the session this request is authenticated by. */
        current: !!currentSessionId && s.id === currentSessionId,
      }));
  }

  /**
   * Revoke one of the caller's own sessions.
   *
   * The `userId` predicate is the security boundary: without it a session id —
   * which the list endpoint hands out freely — would be enough to sign any
   * other user out.
   */
  async revokeSessionById(userId: string, sessionId: string) {
    const result = await this.sessionRepo.update(
      { id: sessionId, userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (!result.affected) {
      throw new NotFoundException('Session not found or already revoked');
    }

    return { revoked: true, sessionId };
  }

  /**
   * Revoke every session the caller holds, across all three portals and every
   * device. This is the "sign me out everywhere" button, and the right response
   * to a suspected compromise.
   */
  async revokeAllSessions(userId: string) {
    const result = await this.sessionRepo.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    return { revoked: true, sessionCount: result.affected ?? 0 };
  }
}
