import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigPack } from '../entities/config-pack.entity';

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
 * Deliberately narrow: no tenant pins, no overrides. Pin resolution is
 * `ConfigPackService.getTenantEffectiveConfig`, which needs a pinned tenant and
 * throws when there is not one. The callers here — a prompt lookup, a template
 * lookup, a document checklist — must work for a tenant that has never been
 * pinned, so they resolve by vertical and treat a missing section as absent
 * rather than as an error.
 */
@Injectable()
export class VerticalPackService {
  private readonly logger = new Logger(VerticalPackService.name);

  constructor(
    @InjectRepository(ConfigPack)
    private readonly configPackRepo: Repository<ConfigPack>,
  ) {}

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

    return this.configPackRepo.findOne({
      where: { vertical, isActive: true },
      order: { version: 'DESC' },
    });
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
