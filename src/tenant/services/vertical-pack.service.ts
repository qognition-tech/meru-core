import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigPack } from '../entities/config-pack.entity';
import { TenantConfigPin } from '../../iam/entities/tenant-config-pin.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/**
 * The one place that answers "give me section X of the config pack serving
 * this vertical".
 *
 * Every module that reads Layer 4 needs the same three steps: find the active
 * pack for the vertical, take the highest version, pull one key out of
 * `schema`. `DocumentChecklistService` had already written those steps inline,
 * and the AI gateway and COM were each about to write them again. Three copies
 * of a resolver is three chances to disagree about which pack wins — and the
 * one that matters is the version tiebreak: picking whichever row the database
 * happened to return first serves an older regulator requirement and looks
 * identical to serving the right one.
 *
 * This is the same consolidation the rest of the platform runs on: one generic
 * mechanism per shape of problem, parameterised by the pack, rather than one
 * implementation per feature that needs it.
 *
 * Pins are honoured here, because this is the read path. A tenant pinned to
 * `ae-grc` via `POST /config-packs/:code/pin` gets the UAE overlay on every
 * section lookup — prompts, templates, checklists, fees, navigation — not only
 * from `ConfigPackService.getTenantEffectiveConfig`, which for months was the
 * only code that consulted `tenant_config_pins` and which nothing on a read
 * path called. The pin is resolved from the ambient `TenantContext` so the
 * fifteen callers did not each have to learn about tenants; outside a request
 * (jobs, bootstrap) there is no tenant and the vertical-wide base applies.
 *
 * Still deliberately narrow: `overrides` on the pin are not merged here. An
 * unpinned tenant must keep working, so a missing pin is the base pack, never
 * an error.
 */
@Injectable()
export class VerticalPackService {
  private readonly logger = new Logger(VerticalPackService.name);

  constructor(
    @InjectRepository(ConfigPack)
    private readonly configPackRepo: Repository<ConfigPack>,
    @InjectRepository(TenantConfigPin)
    private readonly pinRepo: Repository<TenantConfigPin>,
  ) {}

  /**
   * The pack the current tenant has pinned for this vertical, if any.
   *
   * A pin is only honoured when the pinned pack is active and serves the same
   * vertical as the caller asked for — a stale pin to a retired pack, or a pin
   * left over from a vertical change, must not hijack a lookup. Any failure
   * here degrades to the unpinned answer and is logged, because "the pin table
   * is unreadable" is not a reason to serve nothing.
   */
  private async pinnedFor(
    tenantId: string,
    vertical: string,
  ): Promise<ConfigPack | null> {
    try {
      const pins = await this.pinRepo.find({
        where: { tenantId },
        relations: ['configPack'],
        order: { pinnedAt: 'DESC' },
      });
      for (const pin of pins) {
        const pack = pin.configPack;
        if (pack && pack.isActive && pack.vertical === vertical) {
          return pack;
        }
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `Pin lookup failed for tenant ${tenantId}; falling back to the base pack: ${
          (err as Error).message
        }`,
      );
      return null;
    }
  }

  /**
   * The active pack for a vertical, highest version first. `null` when the
   * vertical is unknown or has no pack — never a throw, because "this tenant's
   * vertical has no pack" is a normal state during onboarding and each caller
   * has its own right answer for it.
   *
   * Ordered in SQL. `findOne` without an explicit order returns an arbitrary
   * row, and the arbitrary row is wrong roughly as often as it is right.
   */
  async forVertical(vertical: string | null): Promise<ConfigPack | null> {
    if (!vertical) return null;

    // A pinned tenant gets its pinned pack — usually a country overlay — on
    // every read path, which is what pinning is for.
    const tenantId = TenantContext.getTenantId();
    if (tenantId) {
      const pinned = await this.pinnedFor(tenantId, vertical);
      if (pinned) return pinned;
    }

    // The **base** pack wins over any country overlay, then the highest
    // version. Since packs split into `grc` + `ae-grc`/`sa-grc`/`qa-grc`/
    // `bh-grc`, five rows answer to `vertical = 'grc'` at the same version, and
    // an unordered `findOne` would hand a UAE bank whichever row Postgres
    // returned first — Bahrain's regulators, silently. A tenant that wants its
    // country's overlay pins it explicitly; `ConfigPackService
    // .getTenantEffectiveConfig` resolves that. This is the unpinned fallback,
    // and the only defensible answer for it is the vertical-wide definition.
    return this.configPackRepo
      .createQueryBuilder('p')
      .where('p.vertical = :vertical', { vertical })
      .andWhere('p."isActive" = true')
      .orderBy(`(p.schema->>'country') IS NULL`, 'DESC')
      .addOrderBy('p.version', 'DESC')
      .addOrderBy('p.code', 'ASC')
      .getOne();
  }

  /**
   * One section of the pack's `schema`, typed by the caller.
   *
   * Returns `null` when the pack, the section, or the vertical is missing —
   * three different reasons that all mean "Layer 4 has nothing to say here",
   * which every caller handles the same way. Use `sectionWithPack` when the
   * caller needs to tell them apart or wants to name the pack in an error.
   */
  async section<T>(vertical: string | null, key: string): Promise<T | null> {
    const { section } = await this.sectionWithPack<T>(vertical, key);
    return section;
  }

  /**
   * As `section`, but also returns the pack it came from so a caller can name
   * the pack and version in an error message or a response. Being able to say
   * "au-immigration@1.1.0 defines no prompts" instead of "not found" is the
   * difference between a diagnosable configuration gap and a mystery.
   */
  async sectionWithPack<T>(
    vertical: string | null,
    key: string,
  ): Promise<{ pack: ConfigPack | null; section: T | null }> {
    const pack = await this.forVertical(vertical);
    if (!pack) return { pack: null, section: null };

    const schema = (pack.schema ?? {}) as Record<string, unknown>;
    const value = schema[key];

    if (value === undefined || value === null) {
      return { pack, section: null };
    }

    return { pack, section: value as T };
  }

  /**
   * Convenience for the common case of an array section: an absent section and
   * an empty one are the same thing to a caller iterating it.
   */
  async list<T>(vertical: string | null, key: string): Promise<T[]> {
    const section = await this.section<T[]>(vertical, key);
    return Array.isArray(section) ? section : [];
  }
}
