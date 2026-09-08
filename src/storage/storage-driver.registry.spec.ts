import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { StorageDriverRegistry } from './storage-driver.registry';
import { S3StorageProvider } from './providers/s3.provider';
import { SupabaseStorageProvider } from './providers/supabase.provider';
import { StorageProvider } from './interfaces/storage.interface';
import type { Tenant } from '../iam/entities/tenant.entity';

/**
 * Pins the exact scenario behind the production `POST /documents/upload`
 * finding: Vercel had `AWS_REGION` set with no key/secret/bucket. A driver
 * that registers on partial config becomes a silent default that dials a
 * bucket nobody created, and the caller waits out a full connection timeout
 * before getting a 500 — instead of a fast, honest 503 naming what's missing
 * (CLAUDE.md §5.1b: "none means every upload is a 503 with the variable
 * named, never a hang against a bucket nobody created").
 *
 * This exercises the real construction path — `S3StorageProvider` and
 * `SupabaseStorageProvider` built from env, filtered by `.configured` exactly
 * as `StorageModule`'s `STORAGE_DRIVERS` factory does — not a hand-rolled
 * stand-in for that logic.
 */
describe('StorageDriverRegistry', () => {
  const configWith = (env: Record<string, string>): ConfigService =>
    ({
      get: (key: string, def?: string) => env[key] ?? def,
    }) as unknown as ConfigService;

  const noTenantPin: Repository<Tenant> = {
    findOne: async () => null,
  } as unknown as Repository<Tenant>;

  /** The same `[s3, supabase].filter((d) => d.configured)` as StorageModule. */
  const driversFor = (env: Record<string, string>) => {
    const config = configWith(env);
    const s3 = new S3StorageProvider(config);
    const supabase = new SupabaseStorageProvider(config);
    return [s3, supabase].filter((d) => d.configured);
  };

  const buildRegistry = (env: Record<string, string>) =>
    new StorageDriverRegistry(configWith(env), noTenantPin, driversFor(env));

  it('registers no driver when only AWS_REGION is set', () => {
    const registry = buildRegistry({ AWS_REGION: 'ap-southeast-1' });
    expect(registry.available()).toEqual([]);
    expect(registry.default).toBeNull();
  });

  it('forTenant refuses immediately, naming the missing variables, when AWS_REGION is the only AWS var set', async () => {
    const registry = buildRegistry({ AWS_REGION: 'ap-southeast-1' });
    await expect(registry.forTenant('tenant-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(registry.forTenant('tenant-1')).rejects.toThrow(
      /SUPABASE_URL|AWS_/,
    );
  });

  it('registers S3 once the full credential trio is present, region alone is not enough', () => {
    const registry = buildRegistry({
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIA_TEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_S3_BUCKET: 'meru-test-bucket',
    });
    expect(registry.available()).toEqual([StorageProvider.S3]);
    expect(registry.default).toBe(StorageProvider.S3);
  });

  it('does not register Supabase on a bare SUPABASE_URL without the service role key', () => {
    const registry = buildRegistry({ SUPABASE_URL: 'https://x.supabase.co' });
    expect(registry.available()).toEqual([]);
    expect(registry.default).toBeNull();
  });
});
