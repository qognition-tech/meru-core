import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
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
import { UserPayload, CreateUserInput, DirectoryUser } from '../common/types';
import { TenantContext } from '../core/tenancy/tenant-context';
import { PlatformRole, ROLE_PRECEDENCE } from './enums/platform-role.enum';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
// otplib is pinned to v12 deliberately. v13 pulls in @scure/base and
// @noble/hashes, which are ESM-only; Vercel's serverless loader cannot
// require() an ES module at all, so merely importing this file crashed the
// function on every request with ERR_REQUIRE_ESM. v12's tree (thirty-two +
// node:crypto) is plain CommonJS. See scripts/check-cjs-deps.js.
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

@Injectable()
export class IamService {
  private readonly logger = new Logger(IamService.name);
  private readonly REFRESH_TOKEN_TTL_DAYS = 30;
  private readonly API_KEY_PREFIX = 'meru_';

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Tenant) private tenantRepo: Repository<Tenant>,
    @InjectRepository(Role) private roleRepo: Repository<Role>,
    @InjectRepository(Session) private sessionRepo: Repository<Session>,
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private jwtService: JwtService,
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

  async login(user: UserPayload) {
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

    const tokens = await this.generateTokens(user);
    await this.createSession(user, tokens.refresh_token);

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

  async refreshTokens(refreshToken: string) {
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

    const tokens = await this.generateTokens(payload);
    await this.createSession(payload, tokens.refresh_token);

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
  async verifyMfaLogin(temporaryToken: string, token: string) {
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

    const tokens = await this.generateTokens(payload);
    await this.createSession(payload, tokens.refresh_token);

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

  // ─── Registration ─────────────────────────────────────────────────

  async register(dto: CreateUserInput) {
    // Registration runs unauthenticated: the tenant slug is the only identity
    // signal, so resolving it and checking for a duplicate email both precede
    // any tenant binding.
    const { tenant, existing } = await TenantContext.runAsSystem(
      'resolve tenant by slug during registration',
      async () => ({
        tenant: await this.tenantRepo.findOne({
          where: { slug: dto.tenantSlug },
        }),
        existing: await this.userRepo.findOne({ where: { email: dto.email } }),
      }),
    );

    if (!tenant) throw new NotFoundException('Invalid tenant slug');
    if (existing) throw new ConflictException('Email already registered');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      email: dto.email,
      password: hashedPassword,
      tenantId: tenant.id,
      firstName: dto.firstName,
      lastName: dto.lastName,
      provider: AuthProvider.LOCAL,
      status: UserStatus.ACTIVE,
    });

    return this.userRepo.save(user);
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
  ): Promise<DirectoryUser> {
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
      roles: [dto.role ?? PlatformRole.STAFF],
      attributes: dto.department ? { department: dto.department } : {},
    });

    await this.userRepo.save(user);
    this.logger.log(`Invited ${dto.email} to tenant ${tenantId}`);

    return this.toDirectoryUser(user);
  }

  /**
   * Update a directory user. Deliberately narrow — this cannot touch password,
   * email, tenantId or MFA state, so it can never be used for takeover.
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
  ): Promise<DirectoryUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

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

  private async generateTokens(user: UserPayload) {
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
    });

    const refreshToken = crypto.randomBytes(48).toString('hex');

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600, // 1 hour
      token_type: 'Bearer',
    };
  }

  private async createSession(user: UserPayload, refreshToken: string) {
    const tokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const session = this.sessionRepo.create({
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash,
      refreshTokenHash,
      ipAddress: '',
      userAgent: '',
      expiresAt: new Date(
        Date.now() + this.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    });

    return this.sessionRepo.save(session);
  }
}
