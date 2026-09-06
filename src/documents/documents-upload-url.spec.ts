import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentType } from './entities/document.entity';
import { VersionStatus } from './entities/document-version.entity';
import { StorageProvider } from '../storage/interfaces/storage.interface';

/**
 * `POST /documents/upload` routes through the single Vercel function
 * fronting this API and its own body-size ceiling (CLAUDE.md §10) — a
 * scanned passport or a multi-page PDF routinely exceeds it before this
 * service ever sees the request. `requestUploadUrl` (step one) hands back a
 * signed PUT URL and a storage key; `create` (step two, extended here)
 * finalises the document once the browser has PUT the bytes directly to the
 * bucket.
 *
 * Same construction style as the rest of this directory: `DocumentsService`
 * built directly with hand-rolled repo/storage stubs.
 */
describe('DocumentsService — presigned upload path', () => {
  const TENANT = 't1';
  const USER_ID = 'user-1';

  function build() {
    const savedDocuments: Record<string, any>[] = [];
    const savedVersions: Record<string, any>[] = [];

    const documentRepo = {
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (d: any) => {
        savedDocuments.push(d);
        return d;
      }),
    };
    const versionRepo = {
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (v: any) => {
        savedVersions.push(v);
        return v;
      }),
    };
    const userRepo = {
      findOne: jest.fn(async () => ({ id: USER_ID, email: 'staff@example.com' })),
    };

    const storage = {
      getUploadPresignedUrl: jest.fn(async (tenantId: string, key: string) => ({
        uploadUrl: `https://signed/${key}`,
        provider: StorageProvider.SUPABASE,
        bucket: 'docs-bucket',
      })),
      assertKeyBelongsToTenant: jest.fn((tenantId: string, key: string) => {
        if (!key.startsWith(`tenants/${tenantId}/`)) {
          throw new ForbiddenException('Storage key is outside the caller tenant');
        }
      }),
    };

    const service = new DocumentsService(
      documentRepo as any,
      versionRepo as any,
      {} as any, // metadataRepo
      userRepo as any,
      {} as any, // configService
      {} as any, // dataSource
      {} as any, // orchestrationService
      {} as any, // access — not exercised by these two methods
      storage as any,
    );

    return { service, storage, documentRepo, versionRepo, savedDocuments, savedVersions };
  }

  describe('requestUploadUrl', () => {
    it('asks storage for a key under this tenant\'s prefix and returns it alongside the signed URL', async () => {
      const { service, storage } = build();

      const result = await service.requestUploadUrl(
        { name: 'Passport scan', originalFileName: 'passport.pdf' },
        TENANT,
      );

      expect(storage.getUploadPresignedUrl).toHaveBeenCalledWith(
        TENANT,
        expect.stringContaining(`tenants/${TENANT}/documents/`),
        expect.any(Number),
      );
      expect(result.storageKey).toContain(`tenants/${TENANT}/documents/`);
      expect(result.storageProvider).toBe(StorageProvider.SUPABASE);
      expect(result.storageBucket).toBe('docs-bucket');
      expect(result.uploadUrl).toContain(result.storageKey);
    });

    it('detects the file type from originalFileName when fileType is not given', async () => {
      const { service } = build();
      const result = await service.requestUploadUrl(
        { name: 'Photo', originalFileName: 'photo.png' },
        TENANT,
      );
      expect(result.storageKey.endsWith('.png')).toBe(true);
    });
  });

  describe('create — finalising a direct-to-bucket upload', () => {
    const uploadUrlFields = {
      storageKey: `tenants/${TENANT}/documents/passport-scan-123/v1.pdf`,
      storageProvider: StorageProvider.SUPABASE,
      storageBucket: 'docs-bucket',
    };

    it('with no storage fields, behaves exactly as before — no version, no readable bytes', async () => {
      const { service, savedVersions } = build();

      const doc = await service.create(
        {
          name: 'External reference',
          fileType: DocumentType.PDF,
          originalFileName: 'ref.pdf',
          fileSize: 1234,
        } as any,
        TENANT,
        USER_ID,
      );

      expect(doc.versionNumber).toBe(0);
      // '' is not a valid uuid — Postgres rejected it at parse time before
      // the NOT NULL check ever ran, 500ing every POST /documents call
      // (migration 1756410000000-RelaxDocumentCurrentVersionIdNotNull).
      // A metadata-only document now gets `null`, which is what the entity's
      // `nullable: true` column always promised.
      expect(doc.currentVersionId).toBeNull();
      expect(savedVersions).toHaveLength(0);
    });

    it('with all three storage fields, creates a real version pointing at the uploaded bytes', async () => {
      const { service, savedVersions } = build();

      const doc = await service.create(
        {
          name: 'Passport scan',
          fileType: DocumentType.PDF,
          originalFileName: 'passport.pdf',
          fileSize: 4_500_001, // bigger than the platform's old inline-upload ceiling
          ...uploadUrlFields,
        } as any,
        TENANT,
        USER_ID,
      );

      expect(doc.versionNumber).toBe(1);
      expect(doc.currentVersionId).toBeTruthy();
      expect(savedVersions).toHaveLength(1);
      expect(savedVersions[0]).toMatchObject({
        documentId: doc.id,
        status: VersionStatus.ACTIVE,
        s3Key: uploadUrlFields.storageKey,
        s3Bucket: uploadUrlFields.storageBucket,
        storageProvider: uploadUrlFields.storageProvider,
        fileSize: 4_500_001,
      });
      // The server never touched the bytes — no fabricated checksum.
      expect(savedVersions[0].checksum).toBeUndefined();
    });

    it('validates the key belongs to this tenant before writing anything', async () => {
      const { service, storage, savedDocuments, savedVersions } = build();

      await expect(
        service.create(
          {
            name: 'Forged',
            fileType: DocumentType.PDF,
            originalFileName: 'x.pdf',
            fileSize: 10,
            storageKey: 'tenants/other-tenant/documents/x/v1.pdf',
            storageProvider: StorageProvider.SUPABASE,
            storageBucket: 'docs-bucket',
          } as any,
          TENANT,
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(storage.assertKeyBelongsToTenant).toHaveBeenCalled();
      expect(savedDocuments).toHaveLength(0);
      expect(savedVersions).toHaveLength(0);
    });

    it('rejects a partial set of storage fields rather than silently creating an unreadable document', async () => {
      const { service } = build();

      await expect(
        service.create(
          {
            name: 'Half-finished',
            fileType: DocumentType.PDF,
            originalFileName: 'x.pdf',
            fileSize: 10,
            storageKey: uploadUrlFields.storageKey,
            // storageProvider and storageBucket omitted
          } as any,
          TENANT,
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
