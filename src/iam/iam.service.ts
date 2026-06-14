import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User, AuthProvider, UserStatus } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { UserPayload, CreateUserInput } from '../common/types';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generateSecret, generateURI, verify as totpVerify } from 'otplib';
import * as QRCode from 'qrcode';

@Injectable()
export class IamService {
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
    const user = await this.userRepo.findOne({
      where: { email },
      relations: ['tenant'],
      select: ['id', 'email', 'password', 'tenantId', 'status', 'mfaEnabled'],
    });

    if (
      !user ||
      user.status === UserStatus.LOCKED ||
      user.status === UserStatus.INACTIVE
    ) {
      return null;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;

    // Load roles for this tenant
    const roles = await this.roleRepo.find({
      where: { tenantId: user.tenantId },
    });
    const userRoles = roles.filter((r) => r.isSystem).map((r) => r.name);

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: userRoles,
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

    // Revoke existing active sessions (active = revokedAt is null)
    const activeSessions = await this.sessionRepo.find({
      where: { userId: user.id, revokedAt: null as any },
    });
    for (const s of activeSessions) {
      s.revokedAt = new Date();
    }
    if (activeSessions.length > 0) {
      await this.sessionRepo.save(activeSessions);
    }

    const tokens = await this.generateTokens(user);
    await this.createSession(user, tokens.refresh_token);
    return tokens;
  }

  async refreshTokens(refreshToken: string) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const session = await this.sessionRepo.findOne({
      where: { refreshTokenHash, revokedAt: null as any },
      relations: ['user'],
    });

    if (!session || new Date() > session.expiresAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Revoke old session
    session.revokedAt = new Date();
    await this.sessionRepo.save(session);

    const user = session.user;
    const roles = await this.roleRepo.find({
      where: { tenantId: user.tenantId },
    });
    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: roles.filter((r) => r.isSystem).map((r) => r.name),
    };

    const tokens = await this.generateTokens(payload);
    await this.createSession(payload, tokens.refresh_token);
    return tokens;
  }

  async logout(userId: string) {
    // Revoke all active sessions
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: null as any },
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

    const secret = generateSecret();
    user.mfaSecret = secret;
    await this.userRepo.save(user);

    const otpauthUrl = generateURI({
      label: user.email,
      issuer: 'Meru Platform',
      secret,
    });
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

    const { valid: isValid } = await totpVerify({
      token,
      secret: user.mfaSecret,
    });
    if (!isValid) throw new BadRequestException('Invalid verification code');

    user.mfaEnabled = true;
    await this.userRepo.save(user);
    return { success: true };
  }

  async verifyMfaLogin(userId: string, token: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'email', 'tenantId', 'mfaSecret', 'mfaEnabled'],
    });

    if (!user || !user.mfaSecret || !user.mfaEnabled) {
      throw new BadRequestException('MFA not configured');
    }

    const { valid: isValid } = await totpVerify({
      token,
      secret: user.mfaSecret,
    });
    if (!isValid) throw new UnauthorizedException('Invalid MFA token');

    const roles = await this.roleRepo.find({
      where: { tenantId: user.tenantId },
    });
    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: roles.filter((r) => r.isSystem).map((r) => r.name),
    };

    const tokens = await this.generateTokens(payload);
    await this.createSession(payload, tokens.refresh_token);

    // Update login stats
    await this.userRepo.increment({ id: user.id }, 'loginCount', 1);
    await this.userRepo.update(user.id, { lastLoginAt: new Date() });

    return tokens;
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
    const tenant = await this.tenantRepo.findOne({
      where: { slug: dto.tenantSlug },
    });
    if (!tenant) throw new NotFoundException('Invalid tenant slug');

    const existing = await this.userRepo.findOne({
      where: { email: dto.email },
    });
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
      where: { tenantId, revokedAt: null as any },
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

    const apiKey = await this.apiKeyRepo.findOne({
      where: { keyHash, revokedAt: null as any },
      relations: ['creator'],
    });

    if (!apiKey) return null;
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) return null;

    // Update last used
    await this.apiKeyRepo.update(apiKey.id, { lastUsedAt: new Date() });

    const user = apiKey.creator;
    if (!user) return null;

    const roles = await this.roleRepo.find({
      where: { tenantId: user.tenantId },
    });

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: roles.filter((r) => r.isSystem).map((r) => r.name),
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
      where: { userId, revokedAt: null as any },
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

  async listUsers(tenantId: string) {
    return this.userRepo.find({
      where: { tenantId },
      select: [
        'id',
        'email',
        'firstName',
        'lastName',
        'status',
        'lastLoginAt',
        'createdAt',
        'avatarUrl',
      ],
    });
  }

  async inviteUser(tenantId: string, email: string, _role: string) {
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) throw new ConflictException('User already exists');

    const tempPassword = crypto.randomBytes(16).toString('hex');
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const user = this.userRepo.create({
      email,
      password: hashedPassword,
      tenantId,
      status: UserStatus.INVITED,
      provider: AuthProvider.LOCAL,
    });

    await this.userRepo.save(user);
    // In production: send invitation email with temp password + link
    return { userId: user.id, tempPassword }; // Remove tempPassword return in production
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private async generateTokens(user: UserPayload) {
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles,
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
