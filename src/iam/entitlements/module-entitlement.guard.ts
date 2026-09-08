import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TenantContext } from '../../core/tenancy/tenant-context';
import { GRC_MODULE_CODES, ModuleCode } from './module-code';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

const GRANT_CACHE_TTL_MS = 60_000;

/**
 * Thrown as HTTP 402 so a client can tell "you are not allowed" (403) from
 * "your plan does not include this" (402) and render an upgrade state rather
 * than a permission error. The envelope filter maps it to MER-TENANT-0006.
 */
export class ModuleEntitlementException extends HttpException {
  constructor(missing: ModuleCode[], granted: string[]) {
    super(
      {
        message: `This workspace's plan does not include: ${missing.join(', ')}`,
        missingModules: missing,
        grantedModules: granted,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * Enforces `@RequiresModule`.
 *
 * Until now entitlements were cosmetic: a plan hid nav items and nothing else.
 * This guard makes them real — but only for grants issued under the extended
 * vocabulary. The rule is deliberate and is the whole of the stacking
 * safeguard:
 *
 *   - A grant that lists NONE of the GRC codes predates them. It is an
 *     immigration-era grant (or a GRC tenant provisioned before 2026-08-22)
 *     and is treated as ungated for GRC modules, with a log line. Denying
 *     it would take a live customer's screens away the moment this deployed.
 *   - A grant that lists ANY GRC code was issued knowingly, and is enforced
 *     exactly.
 *
 * Platform-scoped callers (no tenant on the token) pass: there is no grant to
 * check and the role guard is their gate.
 */
@Injectable()
export class ModuleEntitlementGuard implements CanActivate {
  private readonly logger = new Logger(ModuleEntitlementGuard.name);
  private readonly cache = new Map<
    string,
    { modules: string[] | null; expires: number }
  >();

  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ModuleCode[]>(
      REQUIRES_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const tenantId: string | undefined =
      request.user?.tenantId ?? TenantContext.getTenantId();
    if (!tenantId) return true;

    const granted = await this.grantFor(tenantId);
    if (granted === null) {
      // No tenant row or no settings at all: nothing to enforce against.
      return true;
    }

    const issuedUnderGrcVocabulary = granted.some((m) =>
      (GRC_MODULE_CODES as readonly string[]).includes(m),
    );
    const missing = required.filter((m) => !granted.includes(m));
    if (missing.length === 0) return true;

    const missingGrcOnly = missing.every((m) =>
      (GRC_MODULE_CODES as readonly string[]).includes(m),
    );
    if (missingGrcOnly && !issuedUnderGrcVocabulary) {
      this.logger.log(
        `Tenant ${tenantId} grant predates the GRC vocabulary; allowing ` +
          `${missing.join(', ')} ungated (re-provision to enforce)`,
      );
      return true;
    }

    throw new ModuleEntitlementException(missing, granted);
  }

  /** `settings.modules` for the tenant; `null` when there is no list. */
  private async grantFor(tenantId: string): Promise<string[] | null> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.modules;

    const rows = await TenantContext.runAsSystem(
      'module-entitlement grant lookup',
      () =>
        this.dataSource.query<{ modules: unknown }[]>(
          `SELECT settings->'modules' AS modules FROM tenants WHERE id = $1`,
          [tenantId],
        ),
    );
    const raw = rows?.[0]?.modules;
    const modules = Array.isArray(raw)
      ? raw.filter((m): m is string => typeof m === 'string')
      : null;
    this.cache.set(tenantId, {
      modules,
      expires: Date.now() + GRANT_CACHE_TTL_MS,
    });
    return modules;
  }
}
