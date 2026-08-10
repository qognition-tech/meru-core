import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { VerticalPackService } from './vertical-pack.service';
import { TenantProvisioningService } from '../../iam/tenant-provisioning.service';

/** Which portal a nav item or dashboard belongs to. */
export type Portal = 'admin' | 'staff' | 'client' | 'platform';

/** One `navigation[]` entry, as the pack declares it. */
export interface NavItemDefinition {
  key: string;
  label: string;
  path: string;
  icon?: string;
  module?: string;
  roles: string[];
  portal: Portal;
  order: number;
}

/** One widget inside a `dashboards[]` entry. */
export interface DashboardWidgetDefinition {
  key: string;
  label: string;
  type: 'kpi' | 'count' | 'list' | 'chart' | 'checklist';
  source: string;
  when?: unknown;
  groupBy?: string;
  limit: number;
  span: number;
}

/** One `dashboards[]` entry, as the pack declares it. */
export interface DashboardDefinition {
  key: string;
  label: string;
  portal: Portal;
  roles: string[];
  widgets: DashboardWidgetDefinition[];
}

/**
 * Who is asking, in the only three terms the pack can filter on.
 *
 * `modules: null` means "not known" and is deliberately distinct from `[]`,
 * which means "entitled to nothing". Unknown does not gate — a platform
 * operator inspecting a vertical has no tenant entitlement to read, and hiding
 * every gated item from them would look identical to the pack being empty.
 */
export interface UiAudience {
  roles: string[];
  modules: string[] | null;
  portal?: Portal | null;
}

/**
 * The vertical's sidebar and dashboards, filtered to the caller.
 *
 * `navigation[]` and `dashboards[]` are Layer 4 (docs/FEATURE_PARITY_MAP.md §5,
 * item 8) for a reason that had already bitten us twice: the three frontends
 * hardcode their nav, so adding an entity type to a pack — the thing that is
 * supposed to be a JSON edit — still required a frontend release before anyone
 * could reach the page. Nine GovX module pages exist today whose only route to
 * a user is a hand-written sidebar entry.
 *
 * Filtering happens here rather than in the browser because the alternative is
 * three implementations of the same three rules, which is how one portal ends
 * up showing a client a staff-only link. It is still **cosmetic**: hiding a nav
 * item is not an access control, and every route behind it enforces its own.
 */
@Injectable()
export class PackUiService {
  private readonly logger = new Logger(PackUiService.name);

  constructor(
    private readonly packs: VerticalPackService,
    // forwardRef: IamModule already imports TenantModule the same way. The
    // entitlement list is IAM's to compute — `settings.modules ?? plan
    // defaults` — and a second copy of that fallback here would diverge the
    // first time a plan gains a module.
    @Inject(forwardRef(() => TenantProvisioningService))
    private readonly provisioning: TenantProvisioningService,
  ) {}

  /**
   * Build the audience for an authenticated caller.
   *
   * An entitlement lookup that fails leaves `modules: null` rather than
   * throwing: the nav is chrome, and a tenant row that cannot be read should
   * degrade to an ungated sidebar, not to a portal that will not render.
   */
  async audienceFor(
    tenantId: string | null | undefined,
    roles: string[],
    portal?: Portal | null,
  ): Promise<UiAudience> {
    if (!tenantId) return { roles, modules: null, portal };

    try {
      const { modules } = await this.provisioning.getEntitlements(tenantId);
      return { roles, modules, portal };
    } catch (err) {
      this.logger.warn(
        `Entitlements unreadable for tenant ${tenantId}, serving nav ungated: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { roles, modules: null, portal };
    }
  }

  /** The nav the caller should see, in the order the pack declares. */
  async navigationFor(
    vertical: string | null,
    audience: UiAudience,
  ): Promise<NavItemDefinition[]> {
    const items = await this.packs.list<NavItemDefinition>(
      vertical,
      'navigation',
    );

    return items
      .filter((item) => this.visible(item, audience))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  }

  /** Every dashboard the caller may open. Definitions only — no values. */
  async dashboardsFor(
    vertical: string | null,
    audience: UiAudience,
  ): Promise<DashboardDefinition[]> {
    const dashboards = await this.packs.list<DashboardDefinition>(
      vertical,
      'dashboards',
    );

    return dashboards.filter((d) => this.visible(d, audience));
  }

  /**
   * One dashboard by key.
   *
   * A dashboard the caller may not see is a 404, not a 403 — the same rule
   * `/payments` follows. Telling a client-portal user that a staff dashboard
   * exists and is merely closed to them is information they did not have.
   */
  async dashboardFor(
    vertical: string | null,
    key: string,
    audience: UiAudience,
  ): Promise<DashboardDefinition> {
    const dashboards = await this.dashboardsFor(vertical, audience);
    const found = dashboards.find((d) => d.key === key);

    if (!found) {
      throw new NotFoundException(
        `No dashboard '${key}' in the config pack for vertical '${vertical ?? 'unknown'}'`,
      );
    }

    return found;
  }

  /**
   * The three filters, applied identically to a nav item and a dashboard.
   *
   * Empty `roles` means everyone, because that is what a pack author means by
   * leaving it out — the opposite default would hide every item authored
   * without thinking about roles, and the pack would look broken rather than
   * permissive.
   */
  private visible(
    item: { roles?: string[]; portal?: Portal; module?: string },
    audience: UiAudience,
  ): boolean {
    if (audience.portal && (item.portal ?? 'staff') !== audience.portal) {
      return false;
    }

    const roles = item.roles ?? [];
    if (roles.length > 0 && !roles.some((r) => audience.roles.includes(r))) {
      return false;
    }

    if (
      item.module &&
      audience.modules !== null &&
      !audience.modules.includes(item.module)
    ) {
      return false;
    }

    return true;
  }
}
