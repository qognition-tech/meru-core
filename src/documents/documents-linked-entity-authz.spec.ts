import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentAccessService } from './document-access.service';
import { DocumentType } from './entities/document.entity';
import { StorageProvider } from '../storage/interfaces/storage.interface';
import type { Actor } from '../common/access';

/**
 * `POST /documents/upload` and `POST /documents` wrote `dto.linkedEntityId`
 * into the row verbatim, with no ownership check at all —
 * `DocumentAccessService` only ever gated EXISTING documents (`canAccess` /
 * `assert`), so it had no hook on creation. A client could plant a document
 * onto another applicant's checklist simply by naming that applicant's case
 * id in `linkedEntityId`.
 *
 * Same construction style as `documents-upload-url.spec.ts`: `DocumentsService`
 * built directly with hand-rolled repo/storage stubs — but with a REAL
 * `DocumentAccessService` this time, since the seam under test IS that
 * dependency, not the storage/transaction plumbing around it.
 */
describe('DocumentsService — linkedEntityId is ownership-checked on create', () => {
  const T = 'tenant-1';
  const OWNED_CASE = 'case-owned';
  const FOREIGN_CASE = 'case-foreign';

  const staff: Actor = { id: 'staff-1', roles: ['staff'] };
  const clientA: Actor = {
    id: 'client-a',
    roles: ['client'],
    email: 'a@example.test',
  };

  const assignments: Record<string, string[]> = {};
  const subjects: Record<string, string[]> = {
    'a@example.test': [OWNED_CASE],
  };

  function buildAccess() {
    const entities = {
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, any> = {};
        const bind = (_sql: string, p: Record<string, any> = {}) => {
          Object.assign(params, p);
          return qb;
        };
        const qb: any = {
          select: () => qb,
          where: bind,
          andWhere: bind,
          getRawMany: async () => {
            const ids = new Set<string>(assignments[params.userId] ?? []);
            if (params.email) {
              for (const id of subjects[params.email] ?? []) ids.add(id);
            }
            return [...ids].map((id) => ({ id }));
          },
        };
        return qb;
      }),
    };
    return new DocumentAccessService(entities as any);
  }

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
      findOne: jest.fn(async () => ({ id: clientA.id, email: clientA.email })),
    };

    const storage = {
      putObject: jest.fn(async () => ({
        bucket: 'docs-bucket',
        provider: StorageProvider.SUPABASE,
      })),
      signedReadUrl: jest.fn(async () => 'https://signed/read'),
      getUploadPresignedUrl: jest.fn(),
      assertKeyBelongsToTenant: jest.fn(),
    };

    const dataSource = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(async () => undefined),
        startTransaction: jest.fn(async () => undefined),
        commitTransaction: jest.fn(async () => undefined),
        rollbackTransaction: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        manager: {
          create: jest.fn((_entity: unknown, data: any) => ({ ...data })),
          save: jest.fn(async (row: any) => row),
        },
      })),
    };

    const access = buildAccess();

    const service = new DocumentsService(
      documentRepo as any,
      versionRepo as any,
      {} as any, // metadataRepo — not exercised here
      userRepo as any,
      {} as any, // configService
      dataSource as any,
      {} as any, // orchestrationService
      access,
      storage as any,
    );

    return { service, storage, dataSource, savedDocuments, savedVersions };
  }

  const file = {
    size: 1234,
    mimetype: 'application/pdf',
    originalname: 'passport.pdf',
    buffer: Buffer.from('bytes'),
  } as any;

  describe('upload', () => {
    it('refuses a client uploading against a case that is not theirs, 404 not 403', async () => {
      const { service, storage, dataSource } = build();

      await expect(
        service.upload(
          file,
          { name: 'Passport', linkedEntityId: FOREIGN_CASE } as any,
          T,
          clientA,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Refused before a single byte was written or a transaction opened.
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('allows a client uploading against their own case', async () => {
      const { service } = build();

      const result = await service.upload(
        file,
        { name: 'Passport', linkedEntityId: OWNED_CASE } as any,
        T,
        clientA,
      );

      expect(result.document.linkedEntityId).toBe(OWNED_CASE);
    });

    it('allows staff to upload against any case in the tenant', async () => {
      const { service } = build();

      await expect(
        service.upload(
          file,
          { name: 'Passport', linkedEntityId: FOREIGN_CASE } as any,
          T,
          staff,
        ),
      ).resolves.toBeDefined();
    });

    it('an unlinked upload (no linkedEntityId) is unaffected', async () => {
      const { service } = build();

      await expect(
        service.upload(file, { name: 'Unlinked note' } as any, T, clientA),
      ).resolves.toBeDefined();
    });
  });

  describe('create (metadata-only / direct-to-bucket finalise)', () => {
    it('refuses a client attaching a document to a case that is not theirs', async () => {
      const { service } = build();

      await expect(
        service.create(
          {
            name: 'Foreign attach',
            fileType: DocumentType.PDF,
            originalFileName: 'x.pdf',
            fileSize: 10,
            linkedEntityId: FOREIGN_CASE,
          } as any,
          T,
          clientA,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows a client attaching a document to their own case', async () => {
      const { service } = build();

      const doc = await service.create(
        {
          name: 'Own attach',
          fileType: DocumentType.PDF,
          originalFileName: 'x.pdf',
          fileSize: 10,
          linkedEntityId: OWNED_CASE,
        } as any,
        T,
        clientA,
      );

      expect(doc.linkedEntityId).toBe(OWNED_CASE);
    });
  });
});
