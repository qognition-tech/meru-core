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

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const result = safeValidateConfigPack(raw);

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
        messaging: def.messaging ?? { templates: [] },
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
