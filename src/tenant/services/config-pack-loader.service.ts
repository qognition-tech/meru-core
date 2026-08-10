import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import {
  safeValidateConfigPack,
  type ConfigPackDefinition,
} from '../../../packages/config-packs/_schema/pack.schema';
import { ConfigPack } from '../entities/config-pack.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/** What one load pass did, per pack and in aggregate. */
export interface ConfigPackLoadReport {
  /** Resolved directory, reported because "not found" is a real outcome here. */
  packsDir: string;
  packsDirExists: boolean;
  filesFound: number;
  inserted: number;
  upgraded: number;
  upToDate: number;
  packs: Array<{
    code: string;
    fileVersion: string;
    /** Version actually in the database after the write, read back. */
    storedVersion: string | null;
    outcome: 'inserted' | 'up-to-date' | 'upgraded';
    /** False means the write did not take — see `reload`'s note on RLS. */
    verified: boolean;
    sections: string[];
  }>;
  errors: string[];
}

// Reads all JSON files from packages/config-packs/**/*.json at startup,
// validates them with the Zod schema, and upserts into config_packs table.
// This bridges the file-based authoring workflow (GitOps) with the runtime DB.
//
// On conflict (same code): updates schema/defaults/uiConfig/version if the
// file version is higher. Never downgrades.
@Injectable()
export class ConfigPackLoaderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigPackLoaderService.name);
  private readonly packsDir = ConfigPackLoaderService.resolvePacksDir();

  // `__dirname` is dist/src/tenant/services when running from `nest build`
  // output, but Vercel bundles the function with esbuild and the relative hop
  // lands nowhere — the loader then found zero packs and silently seeded
  // nothing. Fall back to the process working directory (Vercel sets it to the
  // deployment root, where vercel.json's `includeFiles` puts packages/).
  private static resolvePacksDir(): string {
    const candidates = [
      path.resolve(__dirname, '../../../../packages/config-packs'),
      path.resolve(process.cwd(), 'packages/config-packs'),
      path.resolve(process.cwd(), '../packages/config-packs'),
    ];
    return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
  }

  constructor(
    @InjectRepository(ConfigPack)
    private readonly configPackRepo: Repository<ConfigPack>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SKIP_CONFIG_PACK_LOADER === 'true') {
      this.logger.log(
        'Config pack loader skipped (SKIP_CONFIG_PACK_LOADER=true)',
      );
      return;
    }

    const report = await this.reload();
    this.logger.log(
      `Config pack loader complete — dir: ${report.packsDir}, files: ${report.filesFound}, ` +
        `inserted: ${report.inserted}, upgraded: ${report.upgraded}, ` +
        `up-to-date: ${report.upToDate}, errors: ${report.errors.length}`,
    );
  }

  /**
   * Load every pack on disk and **report what happened**.
   *
   * This used to be a boot-time side effect that logged and returned nothing,
   * which made it undiagnosable on serverless: cold-start logs are not where
   * anyone looks, and two failure modes are silent by construction —
   *
   *  - the packs directory not being present in the bundle (the loader logs a
   *    warning and cheerfully reports success over zero files), and
   *  - an UPDATE that RLS filters to zero rows. `config_packs` is FORCE RLS
   *    with `platform_global_write ... USING (app.rls_bypassed())`, and a
   *    policy-filtered UPDATE is not an error in Postgres — it affects no rows
   *    and returns cleanly. An initial INSERT can therefore succeed while every
   *    later version upgrade silently does nothing, which presents as a pack
   *    that is permanently one version behind the file that defines it.
   *
   * `verified` closes that second hole by reading the row back after writing
   * and comparing versions, so a swallowed write is reported rather than
   * assumed. Exposed over HTTP by `POST /jobs/packs/reload`.
   */
  async reload(): Promise<ConfigPackLoadReport> {
    // `config_packs` is a platform-global table: readable by every tenant but
    // writable only under an RLS bypass (see AddTenantRowLevelSecurity's
    // platform_global_write policy). Seeding has no tenant, so the whole pass
    // runs as system or every write is rejected by the policy.
    return TenantContext.runAsSystem('load config packs from disk', () =>
      this.loadAll(),
    );
  }

  /**
   * Deep-merge a country overlay onto its vertical base.
   *
   * Objects merge key-by-key; arrays merge **by identity** — an overlay entry
   * whose `key`/`type`/`id`/`code` matches a base entry replaces that entry,
   * anything unmatched is appended. Wholesale array replacement would force
   * every country pack to restate the vertical's nine entity types to add one
   * regulator, which is the duplication the base pack exists to remove.
   *
   * An array of scalars (`locales`) is replaced outright: there is no identity
   * to match on, and "AE speaks Arabic and English" is a statement about AE,
   * not an addition to the vertical's list.
   */
  static merge<T extends Record<string, unknown>>(base: T, overlay: T): T {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;
      const existing = out[key];

      if (Array.isArray(value) && Array.isArray(existing)) {
        out[key] = ConfigPackLoaderService.mergeArrays(existing, value);
      } else if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        out[key] = ConfigPackLoaderService.merge(
          existing as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        out[key] = value;
      }
    }

    return out as T;
  }

  /** The field an array element is identified by, in precedence order. */
  private static identityOf(item: unknown): string | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    for (const field of ['key', 'type', 'id', 'code']) {
      if (typeof record[field] === 'string') return `${field}:${record[field]}`;
    }
    return null;
  }

  private static mergeArrays(base: unknown[], overlay: unknown[]): unknown[] {
    // Scalars, or objects with nothing to match on: the overlay is the answer.
    if (overlay.some((i) => ConfigPackLoaderService.identityOf(i) === null)) {
      return overlay;
    }

    const byIdentity = new Map<string, unknown>();
    const order: string[] = [];

    for (const item of base) {
      const id = ConfigPackLoaderService.identityOf(item);
      if (!id) continue;
      byIdentity.set(id, item);
      order.push(id);
    }

    for (const item of overlay) {
      const id = ConfigPackLoaderService.identityOf(item)!;
      const existing = byIdentity.get(id);
      byIdentity.set(
        id,
        existing && typeof existing === 'object'
          ? ConfigPackLoaderService.merge(
              existing as Record<string, unknown>,
              item as Record<string, unknown>,
            )
          : item,
      );
      if (!order.includes(id)) order.push(id);
    }

    return order.map((id) => byIdentity.get(id));
  }

  private async loadAll(): Promise<ConfigPackLoadReport> {
    const files = this.findPackFiles(this.packsDir);

    const report: ConfigPackLoadReport = {
      packsDir: this.packsDir,
      packsDirExists: fs.existsSync(this.packsDir),
      filesFound: files.length,
      inserted: 0,
      upgraded: 0,
      upToDate: 0,
      packs: [],
      errors: [],
    };

    // Read every file first, so an overlay can extend a base regardless of the
    // order the directory walk happens to return them in.
    const rawByCode = new Map<string, Record<string, unknown>>();
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
          string,
          unknown
        >;
        if (typeof raw.code === 'string') rawByCode.set(raw.code, raw);
      } catch (err: unknown) {
        report.errors.push(
          `${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const resolved = this.resolveInheritance(raw, rawByCode, report);
        const result = safeValidateConfigPack(resolved);

        if (!result.success) {
          report.errors.push(
            `${file}: ${result.error.issues
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('; ')}`,
          );
          continue;
        }

        const outcome = await this.upsertPack(result.data);
        if (outcome === 'inserted') report.inserted++;
        else if (outcome === 'upgraded') report.upgraded++;
        else report.upToDate++;

        // Read back. Without this the report would only say what was
        // attempted, and an RLS-filtered write looks identical to a successful
        // one from the writer's side.
        const stored = await this.configPackRepo.findOne({
          where: { code: result.data.code },
        });

        report.packs.push({
          code: result.data.code,
          fileVersion: result.data.version,
          storedVersion: stored?.version ?? null,
          outcome,
          verified: stored?.version === result.data.version,
          sections: Object.keys(
            (stored?.schema as Record<string, unknown> | undefined) ?? {},
          ).sort(),
        });

        if (stored && stored.version !== result.data.version) {
          report.errors.push(
            `${result.data.code}: write reported '${outcome}' but stored version is ` +
              `${stored.version}, not ${result.data.version} — the write was almost ` +
              `certainly filtered by RLS (config_packs is FORCE RLS and requires ` +
              `app.rls_bypassed() to write).`,
          );
        }
      } catch (err: unknown) {
        report.errors.push(
          `${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const error of report.errors) this.logger.error(error);

    return report;
  }

  /**
   * Walk the `extends` chain and merge base-first.
   *
   * A missing base is reported and the overlay loads alone — a country pack
   * that silently lost its vertical's entity types would present as an empty
   * product, which is far worse than a named error. A cycle is broken at the
   * repeat and reported for the same reason.
   */
  private resolveInheritance(
    raw: Record<string, unknown>,
    all: Map<string, Record<string, unknown>>,
    report: ConfigPackLoadReport,
  ): Record<string, unknown> {
    const chain: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let current = raw;

    while (typeof current.extends === 'string') {
      const parentCode = current.extends;
      if (seen.has(parentCode)) {
        report.errors.push(
          `${String(raw.code)}: circular extends at '${parentCode}' — chain broken here`,
        );
        break;
      }
      seen.add(parentCode);

      const parent = all.get(parentCode);
      if (!parent) {
        report.errors.push(
          `${String(raw.code)}: extends '${parentCode}', which is not on disk — ` +
            `loading the overlay alone, so anything the base defines is missing`,
        );
        break;
      }

      chain.unshift(parent);
      current = parent;
    }

    if (chain.length === 0) return raw;

    // Base-most first, then each descendant, then the pack itself last so it
    // always wins.
    const inherited = chain.reduce(
      (acc, next) => ConfigPackLoaderService.merge(acc, next),
      {} as Record<string, unknown>,
    );

    const merged = ConfigPackLoaderService.merge(inherited, raw);
    // `extends` is a build-time instruction, not stored state — the row that
    // lands in the database is already fully resolved.
    delete merged.extends;
    return merged;
  }

  private findPackFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
      this.logger.warn(`Config packs directory not found: ${dir}`);
      return [];
    }

    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('_')) continue; // skip _schema/
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findPackFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        results.push(fullPath);
      }
    }

    return results;
  }

  private async upsertPack(
    def: ConfigPackDefinition,
  ): Promise<'inserted' | 'up-to-date' | 'upgraded'> {
    const existing = await this.configPackRepo.findOne({
      where: { code: def.code },
    });

    const packData = {
      code: def.code,
      name: def.name,
      description: def.description ?? '',
      version: def.version,
      vertical: def.vertical,
      schema: {
        roles: def.roles ?? [],
        documentTypes: def.documentTypes ?? [],
        workflows: def.workflows ?? [],
        screening: def.screening ?? null,
        compliance: def.compliance ?? null,
        kpis: def.kpis ?? [],
        // Without this key the block is validated and then dropped on the
        // way to the database — the UI would never see it.
        entityTypes: def.entityTypes ?? [],
        regulators: def.regulators ?? [],
        // Same hazard as entityTypes: this list is the *only* thing that
        // reaches the database. A section added to the Zod schema but not
        // named here validates cleanly, loads without error, and then does
        // not exist at runtime — which is indistinguishable from an authoring
        // mistake in the pack. `config-pack-loader.service.spec.ts` asserts
        // every optional section round-trips, so adding one to the schema and
        // forgetting it here fails a test rather than shipping.
        prompts: def.prompts ?? [],
        messaging: def.messaging ?? { templates: [], sequences: [] },
        // The nine Layer 4 arrays (docs/FEATURE_PARITY_MAP.md §5). Each is read
        // by exactly one generic evaluator in core; none of them means anything
        // to core on its own, which is the point — the vertical is the JSON.
        rules: def.rules ?? [],
        alertRules: def.alertRules ?? [],
        fees: def.fees ?? [],
        paymentPlans: def.paymentPlans ?? [],
        scoringModels: def.scoringModels ?? [],
        relationships: def.relationships ?? [],
        navigation: def.navigation ?? [],
        dashboards: def.dashboards ?? [],
        importMappings: def.importMappings ?? [],
        country: def.country,
        locales: def.locales,
        metadata: def.metadata ?? {},
      },
      defaults: (def.defaults as Record<string, unknown>) ?? {},
      uiConfig: def.uiConfig ?? {},
      isActive: true,
    };

    if (!existing) {
      await this.configPackRepo.save(this.configPackRepo.create(packData));
      this.logger.log(`Inserted config pack: ${def.code} v${def.version}`);
      return 'inserted';
    }

    if (this.compareVersions(def.version, existing.version) > 0) {
      await this.configPackRepo.save({ ...existing, ...packData });
      this.logger.log(
        `Upgraded config pack: ${def.code} v${existing.version} → v${def.version}`,
      );
      return 'upgraded';
    }

    return 'up-to-date';
  }

  // Returns positive if a > b, 0 if equal, negative if a < b
  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }
}
