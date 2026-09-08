import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { JwtPayload } from '../../common/types';
import { Session } from '../entities/session.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * How long a revocation may take to bite.
   *
   * Checking the session on every request is one round trip per API call on a
   * serverless deployment; never checking it means logout does not stop the
   * access token until it expires an hour later, which is what
   * `POST /auth/logout-all` was being recommended for. A minute of cache is the
   * honest middle: revocation is effective in ~60s rather than ~60min, at one
   * database read per session per minute.
   */
  private static readonly REVOCATION_TTL_MS = 60_000;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret') || 'default-secret',
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtPayload) {
    await this.assertSessionLive(payload.sid);

    // Payload is attached to request.user
    return {
      id: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      roles: payload.roles,
      // The session this token was issued against. Lets `GET /auth/sessions`
      // mark which row is the caller's current device, and is why the session
      // is created before the token is signed. Absent on tokens issued before
      // that change — treated as "unknown", never as a match.
      sessionId: payload.sid,
      // Only ever set from the signed token, never from a header or body: an
      // attacker who could assert impersonation would be able to launder their
      // own actions under someone else's name in the audit log.
      impersonatedBy: payload.imp,
    };
  }

  /**
   * Reject an access token whose session has been revoked.
   *
   * A token with no `sid` predates session binding and is accepted — refusing
   * it would log out every user holding one, and it expires within the hour
   * anyway. A session row that cannot be read is also accepted: a database
   * blip must not lock every user out of the platform.
   */
  private async assertSessionLive(sessionId?: string): Promise<void> {
    if (!sessionId) return;

    const cacheKey = `session-live:${sessionId}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached === true) return;
    if (cached === false) {
      throw new UnauthorizedException('Session has been revoked');
    }

    let live = true;
    try {
      // Bootstrap lookup: the token's tenant has not been bound yet, and the
      // session row is what authorises binding it.
      const session = await TenantContext.runAsSystem(
        'verify session not revoked',
        () =>
          this.sessionRepo.findOne({
            where: { id: sessionId, revokedAt: IsNull() },
            select: ['id', 'expiresAt'],
          }),
      );
      live = !!session && session.expiresAt > new Date();
    } catch {
      return;
    }

    await this.cache.set(cacheKey, live, JwtStrategy.REVOCATION_TTL_MS);
    if (!live) {
      throw new UnauthorizedException('Session has been revoked');
    }
  }
}
