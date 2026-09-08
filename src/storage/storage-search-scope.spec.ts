import { StorageService } from './storage.service';
import { FileAccess } from './interfaces/storage.interface';

/**
 * `GET /storage/files` → `searchFiles` was tenant-scoped but not
 * user-scoped: any authenticated caller of any role could list every file in
 * the firm — filenames, folders, tags, mimetypes — even though every by-id
 * route (`getFile`, `getDownloadUrl`, ...) already refuses the same caller
 * via `checkAccess()`. Filenames alone are sensitive here
 * (`passport_<name>.pdf`).
 *
 * Same construction style as the rest of this directory's specs: the
 * service built directly with a hand-rolled `fileRepo` stub, everything else
 * unused. `createQueryBuilder` returns a chainable fake that records every
 * `andWhere` call, so these tests pin the WHERE clause `searchFiles` builds
 * rather than needing a real database.
 */
describe('StorageService.searchFiles — actor scoping', () => {
  function build() {
    const andWhereCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
        andWhereCalls.push([sql, params]);
        return qb;
      }),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(async () => [[], 0]),
    };

    const fileRepo = {
      createQueryBuilder: jest.fn(() => qb),
    };

    const service = new StorageService(
      fileRepo as any,
      {} as any, // versionRepo
      {} as any, // multipartRepo
      {} as any, // configService
      {} as any, // dataSource
      {} as any, // eventEmitter
      {} as any, // drivers
    );

    return { service, qb, andWhereCalls };
  }

  const staff = { id: 'staff-1', roles: ['staff'] };
  const client = { id: 'client-a', roles: ['client'] };
  const bareOperator = { id: 'op-1', roles: ['platform_admin'] };

  it("narrows an own-scope caller (client) to files they created, plus public files", async () => {
    const { service, andWhereCalls } = build();

    await service.searchFiles({ tenantId: 't1', actor: client });

    expect(andWhereCalls).toContainEqual([
      '(file.createdById = :actorId OR file.access = :publicAccess)',
      { actorId: 'client-a', publicAccess: FileAccess.PUBLIC },
    ]);
  });

  it('does not narrow the query for tenant staff', async () => {
    const { service, andWhereCalls } = build();

    await service.searchFiles({ tenantId: 't1', actor: staff });

    expect(
      andWhereCalls.some(([sql]) => sql.includes('createdById')),
    ).toBe(false);
  });

  it('narrows a bare platform_admin the same as a client — operator reach is the audited runAsGod path only', async () => {
    const { service, andWhereCalls } = build();

    await service.searchFiles({ tenantId: 't1', actor: bareOperator });

    expect(andWhereCalls).toContainEqual([
      '(file.createdById = :actorId OR file.access = :publicAccess)',
      { actorId: 'op-1', publicAccess: FileAccess.PUBLIC },
    ]);
  });

  it('still scopes tenantId and excludes deleted files regardless of actor', async () => {
    const { service, andWhereCalls, qb } = build();

    await service.searchFiles({ tenantId: 't1', actor: client });

    expect(qb.where).toHaveBeenCalledWith('file.tenantId = :tenantId', {
      tenantId: 't1',
    });
    expect(
      andWhereCalls.some(([sql]) => sql.includes('deletedStatus')),
    ).toBe(true);
  });
});
