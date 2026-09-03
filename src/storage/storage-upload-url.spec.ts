import {
  ForbiddenException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageProvider } from './interfaces/storage.interface';

/**
 * `POST /documents/upload` routes a file through the single Vercel function
 * fronting this API, which enforces its own body-size ceiling (CLAUDE.md
 * §10) — a scanned passport or a multi-page PDF routinely exceeds it before
 * `DocumentsController.upload` ever runs. `getUploadPresignedUrl` is the
 * fix's storage-layer half: a short-TTL signed PUT URL the browser can use
 * directly, so the bytes never pass through the function at all.
 *
 * Same construction style as the rest of this directory's specs: the service
 * built directly with a hand-rolled `drivers` stub, everything else unused.
 */
describe('StorageService.getUploadPresignedUrl', () => {
  const T = 't1';

  function build(driverOverrides: Record<string, unknown> = {}) {
    const driver = {
      kind: StorageProvider.SUPABASE,
      bucket: 'docs-bucket',
      getUploadPresignedUrl: jest.fn(async (key: string, ttl: number) => `https://signed/${key}?ttl=${ttl}`),
      ...driverOverrides,
    };

    const drivers = {
      forTenant: jest.fn(async () => driver),
      require: jest.fn((d: any, method: string) => {
        const fn = d[method];
        if (typeof fn !== 'function') {
          throw new NotImplementedException(
            `${method} is not supported by the "${d.kind}" storage provider`,
          );
        }
        return fn.bind(d);
      }),
    };

    const service = new StorageService(
      {} as any, // fileRepo
      {} as any, // versionRepo
      {} as any, // multipartRepo
      {} as any, // configService
      {} as any, // dataSource
      {} as any, // eventEmitter
      drivers as any,
    );

    return { service, drivers, driver };
  }

  it('returns a signed upload URL, the driver and the bucket for a key under the tenant prefix', async () => {
    const { service, driver } = build();

    const result = await service.getUploadPresignedUrl(
      T,
      `tenants/${T}/documents/passport-scan/v1.pdf`,
      300,
    );

    expect(result.provider).toBe(StorageProvider.SUPABASE);
    expect(result.bucket).toBe('docs-bucket');
    expect(result.uploadUrl).toContain(`tenants/${T}/documents/passport-scan/v1.pdf`);
    expect(driver.getUploadPresignedUrl).toHaveBeenCalled();
  });

  it('refuses a key outside the caller\'s own tenant prefix, before any driver is consulted', async () => {
    const { service, drivers } = build();

    await expect(
      service.getUploadPresignedUrl(T, `tenants/other-tenant/documents/x/v1.pdf`, 300),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(drivers.forTenant).not.toHaveBeenCalled();
  });

  it('clamps the requested TTL to the same 15-minute ceiling read URLs use', async () => {
    const { service, driver } = build();

    await service.getUploadPresignedUrl(T, `tenants/${T}/documents/x/v1.pdf`, 60 * 60);

    expect(driver.getUploadPresignedUrl).toHaveBeenCalledWith(
      expect.any(String),
      15 * 60,
    );
  });

  it('answers 503 with unavailableReason when no driver is configured, rather than an obscure failure', async () => {
    const { service, drivers } = build();
    drivers.forTenant.mockRejectedValue(
      new Error('Object storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'),
    );

    try {
      await service.getUploadPresignedUrl(T, `tenants/${T}/documents/x/v1.pdf`, 300);
      throw new Error('expected getUploadPresignedUrl to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const response = (err as ServiceUnavailableException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.unavailableReason).toBe('storage_not_configured');
      expect(response.code).toBe('MER-SRV-0503');
    }
  });

  it('answers 501 when the configured driver has no upload-URL support', async () => {
    const { service } = build({ getUploadPresignedUrl: undefined });

    await expect(
      service.getUploadPresignedUrl(T, `tenants/${T}/documents/x/v1.pdf`, 300),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });
});

describe('StorageService.assertKeyBelongsToTenant', () => {
  function build() {
    return new StorageService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { forTenant: jest.fn(), require: jest.fn() } as any,
    );
  }

  it('passes silently for a key under the tenant prefix', () => {
    const service = build();
    expect(() =>
      service.assertKeyBelongsToTenant('t1', 'tenants/t1/documents/x/v1.pdf'),
    ).not.toThrow();
  });

  it('throws for a key under a different tenant prefix — the guard POST /documents relies on when finalising a direct upload', () => {
    const service = build();
    expect(() =>
      service.assertKeyBelongsToTenant('t1', 'tenants/t2/documents/x/v1.pdf'),
    ).toThrow(ForbiddenException);
  });
});
