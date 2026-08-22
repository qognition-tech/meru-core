import {
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../iam/entities/tenant.entity';
import {
  ObjectStorageDriver,
  StorageProvider,
  STORAGE_DRIVERS,
} from './interfaces/storage.interface';

/**
 * Which object store holds which bytes.
 *
 * Two questions, answered separately because they have different inputs:
 *
 *  - **Where does a NEW object go?** `forTenant(tenantId)` — the tenant's
 *    pinned provider (`tenants.settings.storage.provider`) if it names one
 *    that is configured, else the platform default (`STORAGE_PROVIDER`, or the
 *    single configured driver when there is exactly one).
 *  - **Where is an EXISTING object?** `forFile(provider)` — whatever the row
 *    recorded when it was written. A tenant changing its pin must not make
 *    every file it already has unreadable, so reads never consult the pin.
 *
 * `getProviderInstance(tenantId)` used to return the one S3 instance
 * unconditionally, which meant the `provider` column on every row was
 * decoration and the "per-tenant provider" the docs described did not exist.
 *
 * No configured driver is a **503 with the variable named**, never a driver
 * that silently targets a bucket nobody created. Uploads were returning 500
 * `timeout exceeded when trying to connect` for that reason.
 */
@Injectable()
export class StorageDriverRegistry {
  private readonly logger = new Logger(StorageDriverRegistry.name);
  private readonly drivers = new Map<StorageProvider, ObjectStorageDriver>();
  private readonly defaultKind: StorageProvider | null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @Optional() @Inject(STORAGE_DRIVERS) drivers: ObjectStorageDriver[] = [],
  ) {
    for (const d of drivers) {
      if (d) this.drivers.set(d.kind, d);
    }

    const configured = this.config.get<string>('STORAGE_PROVIDER')?.trim();
    if (configured) {
      if (this.drivers.has(configured as StorageProvider)) {
        this.defaultKind = configured as StorageProvider;
      } else {
        this.logger.error(
          `STORAGE_PROVIDER=${configured} names a driver that is not configured ` +
            `(available: ${[...this.drivers.keys()].join(', ') || 'none'}). ` +
            `Uploads will be refused until its credentials are set.`,
        );
        this.defaultKind = null;
      }
    } else if (this.drivers.size === 1) {
      this.defaultKind = [...this.drivers.keys()][0];
    } else {
      this.defaultKind = null;
      if (this.drivers.size === 0) {
        this.logger.warn(
          'No object storage driver is configured. Document upload and ' +
            'download will return 503 until SUPABASE_URL + ' +
            'SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_STORAGE_BUCKET) are set.',
        );
      } else {
        this.logger.error(
          `${this.drivers.size} storage drivers are configured and ` +
            `STORAGE_PROVIDER does not choose between them. Uploads refused.`,
        );
      }
    }
  }

  /** Every driver that has credentials, for the capability report. */
  available(): StorageProvider[] {
    return [...this.drivers.keys()];
  }

  get default(): StorageProvider | null {
    return this.defaultKind;
  }

  /** The driver a file row recorded. Reads never consult the tenant pin. */
  forFile(provider: StorageProvider | string | null | undefined): ObjectStorageDriver {
    const kind = (provider ?? this.defaultKind) as StorageProvider | null;
    const driver = kind ? this.drivers.get(kind) : undefined;
    if (!driver) {
      throw new ServiceUnavailableException(
        `Object storage provider "${kind ?? 'unset'}" is not configured, so ` +
          `this file cannot be reached. It is not lost; set the provider's ` +
          `credentials and it becomes readable again.`,
      );
    }
    return driver;
  }

  /** The driver a NEW object for this tenant goes to. */
  async forTenant(tenantId: string): Promise<ObjectStorageDriver> {
    const pinned = await this.pinnedProvider(tenantId);
    if (pinned && this.drivers.has(pinned)) {
      return this.drivers.get(pinned)!;
    }
    if (pinned) {
      this.logger.warn(
        `Tenant ${tenantId} pins storage provider "${pinned}" which is not ` +
          `configured; falling back to the platform default.`,
      );
    }
    if (!this.defaultKind) {
      throw new ServiceUnavailableException(
        'Object storage is not configured. Set SUPABASE_URL and ' +
          'SUPABASE_SERVICE_ROLE_KEY (and STORAGE_PROVIDER when more than one ' +
          'driver is present).',
      );
    }
    return this.drivers.get(this.defaultKind)!;
  }

  /**
   * Refuse, by name, an operation this provider has no concept of.
   *
   * Used for storage classes and multipart part-signing, which are S3 ideas.
   * A 501 tells the caller the platform cannot do it here, which is true;
   * a 200 that changed nothing would not be.
   */
  require<K extends keyof ObjectStorageDriver>(
    driver: ObjectStorageDriver,
    method: K,
  ): NonNullable<ObjectStorageDriver[K]> {
    const fn = driver[method];
    if (typeof fn !== 'function') {
      throw new NotImplementedException(
        `${String(method)} is not supported by the "${driver.kind}" storage provider`,
      );
    }
    return fn.bind(driver) as NonNullable<ObjectStorageDriver[K]>;
  }

  private async pinnedProvider(
    tenantId: string,
  ): Promise<StorageProvider | null> {
    try {
      const t = await this.tenants.findOne({
        where: { id: tenantId },
        select: ['id', 'settings'],
      });
      const v = (t?.settings as any)?.storage?.provider;
      return typeof v === 'string' && v ? (v as StorageProvider) : null;
    } catch (e) {
      this.logger.warn(
        `Could not read storage pin for tenant ${tenantId}: ${(e as Error).message}`,
      );
      return null;
    }
  }
}
