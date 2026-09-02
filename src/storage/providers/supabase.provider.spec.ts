import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageProvider } from './supabase.provider';
import {
  ObjectStorageDriver,
  StorageProvider,
} from '../interfaces/storage.interface';

/**
 * A storage-js call result, as the mocks below must be allowed to return it.
 *
 * `jest.fn(async () => ({ data: {...}, error: null }))` infers `error` as
 * exactly `null`, so a later `mockResolvedValueOnce({ data: null, error: {...} })`
 * — the whole point of the error-mapping test — does not type-check. Naming the
 * union once keeps the failure path typed instead of reaching for `any`.
 */
type SbResult<T> = { data: T | null; error: { message: string } | null };

/**
 * The driver is a thin adapter, so what is worth proving is the part that
 * would be silently wrong: that it refuses to exist without credentials,
 * that it never mints a public URL, that read URLs are clamped short, that
 * the optional S3-only members are genuinely absent rather than stubbed, and
 * that storage-js errors become HTTP errors instead of `{ data: null }`.
 */
describe('SupabaseStorageProvider', () => {
  const config = (env: Record<string, string>) =>
    ({ get: (k: string, d?: string) => env[k] ?? d }) as unknown as ConfigService;

  const mockBucket = () => ({
    upload: jest.fn(
      async (): Promise<SbResult<{ path: string }>> => ({
        data: { path: 'k' },
        error: null,
      }),
    ),
    download: jest.fn(
      async (): Promise<SbResult<{ arrayBuffer: () => Promise<ArrayBuffer> }>> => ({
        data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
        error: null,
      }),
    ),
    remove: jest.fn(async () => ({ data: [], error: null })),
    copy: jest.fn(async () => ({ data: { path: 'b' }, error: null })),
    move: jest.fn(async () => ({ data: { message: 'ok' }, error: null })),
    createSignedUrl: jest.fn(async (_k: string, ttl: number) => ({
      data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/b/k?token=t&exp=${ttl}` },
      error: null,
    })),
    createSignedUploadUrl: jest.fn(async () => ({
      data: { signedUrl: 'https://x/upload?token=t', token: 't', path: 'k' },
      error: null,
    })),
    info: jest.fn(async () => ({
      data: { size: 3, etag: '"abc"', lastModified: '2026-08-22T00:00:00Z', metadata: { a: 1 } },
      error: null,
    })),
    list: jest.fn(async () => ({
      data: [
        { id: 'o1', name: 'v1.pdf', updated_at: '2026-08-22T00:00:00Z', metadata: { size: 9, eTag: '"e"' } },
        { id: null, name: 'subfolder', metadata: null },
      ],
      error: null,
    })),
    getPublicUrl: jest.fn(() => ({ data: { publicUrl: 'https://PUBLIC' } })),
  });

  const build = (env: Record<string, string> = {}) => {
    const bucket = mockBucket();
    const client = {
      storage: { from: jest.fn(() => bucket) },
    } as unknown as SupabaseClient;
    const driver = new SupabaseStorageProvider(
      config({ SUPABASE_STORAGE_BUCKET: 'docs', ...env }),
      client,
    );
    return { driver, bucket };
  };

  it('is not configured without URL and service key, and says so', () => {
    const driver = new SupabaseStorageProvider(config({}));
    expect(driver.configured).toBe(false);
    expect(driver.kind).toBe(StorageProvider.SUPABASE);
  });

  it('is configured with URL and service key', () => {
    const driver = new SupabaseStorageProvider(
      config({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    );
    expect(driver.configured).toBe(true);
    expect(driver.bucket).toBe('meru-documents');
  });

  it('does not implement the S3-only optional members', () => {
    // Honest absence, not a stub that resolves. StorageService reports the
    // operation as unsupported for this provider when these are undefined.
    //
    // Read through `ObjectStorageDriver`, where these members are declared
    // optional, rather than through the concrete class, where they are absent
    // entirely and every line below is a compile error instead of an
    // assertion. The distinction is the point of the test: the contract offers
    // them, this driver does not provide them, and that must stay observable.
    const driver: ObjectStorageDriver = build().driver;
    expect(driver.initiateMultipartUpload).toBeUndefined();
    expect(driver.completeMultipartUpload).toBeUndefined();
    expect(driver.abortMultipartUpload).toBeUndefined();
    expect(driver.getPresignedUrlForPart).toBeUndefined();
    expect(driver.changeStorageClass).toBeUndefined();
  });

  it('uploads without upsert and returns the MD5 of what it sent', async () => {
    const { driver, bucket } = build();
    const buf = Buffer.from('hello');
    const out = await driver.upload(buf, 'tenants/t1/documents/a/v1.pdf', {
      contentType: 'application/pdf',
    });
    expect(bucket.upload).toHaveBeenCalledWith(
      'tenants/t1/documents/a/v1.pdf',
      buf,
      expect.objectContaining({ contentType: 'application/pdf', upsert: false }),
    );
    expect(out.etag).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('downloads to a Buffer', async () => {
    const { driver } = build();
    const out = await driver.download('tenants/t1/x');
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('signs read URLs server-side, never public, and clamps the TTL', async () => {
    const { driver, bucket } = build();
    const url = await driver.getPresignedUrl('tenants/t1/x', {
      fileId: 'x',
      expiresInSeconds: 60 * 60 * 24,
    });
    expect(bucket.getPublicUrl).not.toHaveBeenCalled();
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      'tenants/t1/x',
      SupabaseStorageProvider.MAX_SIGNED_READ_TTL_SECONDS,
      expect.any(Object),
    );
    expect(url).toContain('token=');
  });

  it('defaults the read TTL to five minutes', async () => {
    const { driver, bucket } = build();
    await driver.getPresignedUrl('tenants/t1/x', { fileId: 'x' });
    expect(bucket.createSignedUrl.mock.calls[0][1]).toBe(
      SupabaseStorageProvider.DEFAULT_SIGNED_READ_TTL_SECONDS,
    );
  });

  it('turns a storage-js error into an HTTP error, not a null result', async () => {
    const { driver, bucket } = build();
    bucket.download.mockResolvedValueOnce({ data: null, error: { message: 'Object not found' } });
    await expect(driver.download('tenants/t1/missing')).rejects.toMatchObject({
      status: 404,
    });
    bucket.upload.mockResolvedValueOnce({ data: null, error: { message: 'quota exceeded' } });
    await expect(driver.upload(Buffer.from('x'), 'tenants/t1/y')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('reads object metadata and reports the single Supabase storage class', async () => {
    const { driver } = build();
    const meta = await driver.getObjectMetadata('tenants/t1/x');
    expect(meta.size).toBe(3);
    expect(meta.etag).toBe('abc');
    expect(meta.storageClass).toBe('supabase');
    expect(meta.metadata).toEqual({ a: 1 });
  });

  it('lists objects under a prefix and drops folder pseudo-entries', async () => {
    const { driver } = build();
    const out = await driver.listObjects('tenants/t1/documents/a/');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'tenants/t1/documents/a/v1.pdf', size: 9, etag: 'e' });
  });

  it('copy, move and delete pass the keys straight through', async () => {
    const { driver, bucket } = build();
    await driver.copy('tenants/t1/a', 'tenants/t1/b');
    await driver.move('tenants/t1/b', 'tenants/t1/c');
    await driver.delete('tenants/t1/c');
    expect(bucket.copy).toHaveBeenCalledWith('tenants/t1/a', 'tenants/t1/b');
    expect(bucket.move).toHaveBeenCalledWith('tenants/t1/b', 'tenants/t1/c');
    expect(bucket.remove).toHaveBeenCalledWith(['tenants/t1/c']);
  });
});
