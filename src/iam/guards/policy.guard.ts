import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VerticalPolicyService } from '../../core/verticals/vertical-policy.service';
import { TenantContext } from '../../core/tenancy/tenant-context';
import { VerticalType } from '../enums/vertical.enum';
import { User } from '../entities/user.entity';

// Tenant verticals effectively never change; a short in-process cache keeps
// the guard off the DB hot path while bounding how long a re-verticaled
// tenant could see stale policy.
const VERTICAL_CACHE_TTL_MS = 5 * 60_000;

@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly verticalCache = new Map<
    string,
    { vertical: VerticalType; expires: number }
  >();

  constructor(
    private reflector: Reflector,
    private verticalPolicyService: VerticalPolicyService,
    @InjectDataSource() private dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as User;

    if (!user) throw new ForbiddenException('Unauthorized');

    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (
      requiredRoles &&
      !requiredRoles.some((role) => user.roles.includes(role))
    ) {
      throw new ForbiddenException('Insufficient Role Privileges');
    }

    const vertical = await this.resolveVertical(request);
    if (!vertical) {
      // No tenant on the token (platform-scoped caller): the role check above
      // is the gate; there is no vertical policy to apply.
      return true;
    }

    const policy = await this.verticalPolicyService.getPolicy(vertical);

    // Context-aware checks
    // IP Whitelist
    if (policy.rules.ipWhitelist && policy.rules.ipWhitelist.length > 0) {
      const ip = request.ip;
      if (!policy.rules.ipWhitelist.includes(ip)) {
        throw new ForbiddenException(
          `Access Denied: IP ${ip} not whitelisted.`,
        );
      }
    }

    // Business Hours
    if (policy.rules.businessHours) {
      const hour = new Date().getHours();
      const { start, end } = policy.rules.businessHours;
      if (hour < start || hour >= end) {
        throw new ForbiddenException(
          `Access Denied: Outside business hours (${start}:00 - ${end}:00).`,
        );
      }
    }

    return true;
  }

  private async resolveVertical(request: {
    user?: { tenant?: { vertical?: VerticalType }; tenantId?: string };
  }): Promise<VerticalType | null> {
    const attached = request.user?.tenant?.vertical;
    if (attached) return attached;

    const tenantId = request.user?.tenantId;
    if (!tenantId) return null;

    const cached = this.verticalCache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.vertical;

    // Guards run before TenantBindingInterceptor, so the pooled connection is
    // not yet bound to a tenant and RLS on `tenants` would match zero rows.
    // This is an identity-bootstrap lookup — the documented use of
    // runAsSystem (CLAUDE.md §6.4).
    const rows = await TenantContext.runAsSystem(
      'policy-guard vertical lookup',
      () =>
        this.dataSource.query<{ vertical: VerticalType }[]>(
          'SELECT vertical FROM tenants WHERE id = $1',
          [tenantId],
        ),
    );

    const vertical = rows?.[0]?.vertical ?? null;
    if (vertical) {
      this.verticalCache.set(tenantId, {
        vertical,
        expires: Date.now() + VERTICAL_CACHE_TTL_MS,
      });
    }
    return vertical;
  }
}
