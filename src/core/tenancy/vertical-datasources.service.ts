import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from '../../config/entities';
import { applyRlsToDataSource, assertRlsEnforceable } from './rls.datasource';

/**
 * Per-vertical database routing (the three-Neon-DB split).
 *
 * The control plane (IAM, tenants, billing, config packs, flags, platform
 * audit) lives on the default DataSource. Vertical domain data moves to its
 * own database — `GOVX_DB_APP_URL` for grc, `IMMISTACK_DB_APP_URL` for
 * immigration. A vertical with no URL configured shares the default database,
 * so environments migrate one at a time with no flag day.
 *
 * Every vertical DataSource loads the same entity catalogue and gets the same
 * RLS treatment as the default one: applyRlsToDataSource binds the ALS tenant
 * onto every pooled checkout, and assertRlsEnforceable refuses a role holding
 * BYPASSRLS in production. A vertical DB is NOT a substitute for RLS — it is
 * blast-radius containment on top of it.
 */
@Injectable()
export class VerticalDataSources implements OnModuleDestroy {
  private readonly logger = new Logger(VerticalDataSources.name);
  /** vertical → init promise; promise-cached so concurrent first calls share one init. */
  private readonly sources = new Map<string, Promise<DataSource>>();

  constructor(
    @InjectDataSource() private readonly defaultDataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  private urlFor(vertical: string): string | undefined {
    switch (vertical) {
      case 'grc':
        return this.configService.get<string>('database.govxUrl');
      case 'immigration':
        return this.configService.get<string>('database.immistackUrl');
      default:
        return undefined;
    }
  }

  /** The DataSource vertical-scoped queries should run on. */
  forVertical(vertical?: string | null): Promise<DataSource> {
    const url = vertical ? this.urlFor(vertical) : undefined;
    if (!vertical || !url) return Promise.resolve(this.defaultDataSource);

    let source = this.sources.get(vertical);
    if (!source) {
      source = this.initialize(vertical, url);
      this.sources.set(vertical, source);
      // A failed init must not poison the cache forever.
      source.catch(() => this.sources.delete(vertical));
    }
    return source;
  }

  private async initialize(vertical: string, url: string): Promise<DataSource> {
    const isServerless = !!process.env.VERCEL;
    const ds = new DataSource({
      type: 'postgres',
      url,
      entities: ALL_ENTITIES,
      synchronize: false,
      ssl: { rejectUnauthorized: false },
      extra: isServerless
        ? { max: 1, connectionTimeoutMillis: 10000 }
        : { max: 10 },
    });

    await ds.initialize();
    applyRlsToDataSource(ds);
    await assertRlsEnforceable(ds);
    this.logger.log(`Vertical DataSource initialized: ${vertical}`);
    return ds;
  }

  async onModuleDestroy(): Promise<void> {
    for (const source of this.sources.values()) {
      const ds = await source.catch(() => null);
      if (ds?.isInitialized) await ds.destroy();
    }
  }
}
