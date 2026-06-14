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

// Reads all JSON files from packages/config-packs/**/*.json at startup,
// validates them with the Zod schema, and upserts into config_packs table.
// This bridges the file-based authoring workflow (GitOps) with the runtime DB.
//
// On conflict (same code): updates schema/defaults/uiConfig/version if the
// file version is higher. Never downgrades.
@Injectable()
export class ConfigPackLoaderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigPackLoaderService.name);
  private readonly packsDir = path.resolve(
    __dirname,
    '../../../../packages/config-packs',
  );

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

    this.logger.log(`Loading config packs from ${this.packsDir}`);
    const files = this.findPackFiles(this.packsDir);
    this.logger.log(`Found ${files.length} config pack file(s)`);

    let loaded = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const result = safeValidateConfigPack(raw);

        if (!result.success) {
          this.logger.error(
            `Invalid config pack ${file}: ${result.error.issues.map((i) => i.message).join(', ')}`,
          );
          errors++;
          continue;
        }

        const outcome = await this.upsertPack(result.data);
        if (outcome === 'inserted') loaded++;
        else skipped++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to load config pack ${file}: ${msg}`);
        errors++;
      }
    }

    this.logger.log(
      `Config pack loader complete — inserted: ${loaded}, up-to-date: ${skipped}, errors: ${errors}`,
    );
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
        regulators: def.regulators ?? [],
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
