import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Guards the Vercel Cron job endpoints with a shared secret.
 *
 * Fails CLOSED: if `CRON_SECRET` is not configured the guard denies every
 * request rather than letting the endpoints run unauthenticated.
 */
@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.CRON_SECRET;

    // Fail closed — never fail open when the secret is missing/blank.
    if (!expected || expected.trim().length === 0) {
      this.logger.error(
        'CRON_SECRET is not configured — denying cron job request',
      );
      throw new UnauthorizedException('Cron authentication is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers?.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed bearer token');
    }

    const provided = header.slice('Bearer '.length);

    if (!this.safeCompare(provided, expected)) {
      this.logger.warn('Rejected cron job request: invalid secret');
      throw new UnauthorizedException('Invalid cron secret');
    }

    return true;
  }

  /**
   * timingSafeEqual throws when buffer lengths differ, so length is checked
   * first. The length check itself is not constant-time, which only leaks the
   * secret's length — an acceptable trade-off versus the throw.
   */
  private safeCompare(provided: string, expected: string): boolean {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    if (a.length !== b.length) {
      return false;
    }

    return timingSafeEqual(a, b);
  }
}
