import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenancy state. Carried in AsyncLocalStorage so that any code —
 * repositories, services, raw query runners — can discover the caller's tenant
 * without threading it through every signature.
 *
 * The store object is intentionally MUTABLE: the ALS context is entered by
 * `TenantAlsMiddleware` (which runs before guards, so `req.user` does not exist
 * yet) and populated later by `TenantBindingInterceptor` (which runs after
 * guards, once the JWT has been validated). Mutating the same object means
 * everything downstream observes the tenant id.
 */
export interface TenantStore {
  /** Tenant that owns this unit of work. Undefined until auth has run. */
  tenantId?: string;
  /**
   * When set, RLS policies are bypassed for the duration of the callback.
   * Reserved for platform bootstrap and explicitly audited operator access.
   */
  bypass?: { kind: 'system' | 'god'; reason: string; actorId?: string };
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * Tenant context accessor (CLAUDE.md §6.4 — strict multi-tenancy).
 *
 * The value here is mirrored into the Postgres session as `app.current_tenant_id`
 * by `applyRlsToDataSource`, where the `tenant_isolation` RLS policies read it.
 * Application-side filtering is *not* the isolation boundary — the database is.
 * This context exists to tell the database who is asking.
 */
export const TenantContext = {
  /** Enter a new context. Used by the ALS middleware and by worker entrypoints. */
  run<T>(store: TenantStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  get(): TenantStore | undefined {
    return storage.getStore();
  },

  getTenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  },

  /**
   * Populate the tenant on the *current* store. Returns false when called
   * outside a context, which indicates the ALS middleware did not run.
   */
  setTenantId(tenantId: string | undefined): boolean {
    const store = storage.getStore();
    if (!store) return false;
    store.tenantId = tenantId;
    return true;
  },

  getBypass(): TenantStore['bypass'] {
    return storage.getStore()?.bypass;
  },

  isBypassed(): boolean {
    return storage.getStore()?.bypass !== undefined;
  },

  /**
   * Run platform-internal work that legitimately cannot know a tenant yet.
   *
   * The only valid uses are bootstrap lookups that *establish* identity —
   * resolving a user by email at login, validating an API key hash, loading a
   * session by refresh token — and background workers that iterate tenants.
   * Keep this surface small: every call site is a hole in tenant isolation.
   *
   * For an operator deliberately reading another tenant's data, use
   * `runAsGod` instead so the access is written to the audit log.
   */
  runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    const parent = storage.getStore();
    return storage.run(
      { ...parent, bypass: { kind: 'system', reason } },
      fn,
    );
  },

  /**
   * Cross-tenant access by a human operator. CLAUDE.md §6.4 requires an audit
   * entry for this; `TenancyService.runAsGod` is the wrapper that writes one.
   * Prefer that over calling this directly.
   */
  runAsGod<T>(actorId: string, reason: string, fn: () => Promise<T>): Promise<T> {
    const parent = storage.getStore();
    return storage.run(
      { ...parent, bypass: { kind: 'god', reason, actorId } },
      fn,
    );
  },
};
