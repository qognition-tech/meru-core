import { NotFoundException } from '@nestjs/common';
import { DocumentAccessService } from './document-access.service';
import { MeruErrorCode } from '../common/types';

/**
 * `DocumentAccessService.listMetadataForTenant` (ADR 0009 §2.3) backs
 * `GET /platform/tenants/:id/documents` and must never widen into a bytes
 * path. The field list here is the actual contract with the caller — this
 * suite pins the exact `select` TypeORM is asked for, not just "some rows
 * came back", because a later `select: '*'` or a dropped `select` array
 * entirely would silently start returning `s3Url`/`rbac`/`aiAnalysis`
 * (the last may hold extracted PII text) with no other signal.
 */
describe('DocumentAccessService.listMetadataForTenant', () => {
  const find = jest.fn();
  const findOne = jest.fn();
  const documents = { find };
  const tenants = { findOne };

  const make = () =>
    new DocumentAccessService(undefined as any, documents as any, tenants as any);

  beforeEach(() => {
    find.mockReset();
    findOne.mockReset();
  });

  it('404s with MER-TENANT-0001 when the tenant does not exist', async () => {
    findOne.mockResolvedValue(null);

    await expect(make().listMetadataForTenant('missing')).rejects.toMatchObject(
      {
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_NOT_FOUND,
        }),
      },
    );
    await expect(make().listMetadataForTenant('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('requests metadata columns only — never s3Url, rbac or aiAnalysis', async () => {
    findOne.mockResolvedValue({ id: 'tenant-1' });
    find.mockResolvedValue([]);

    await make().listMetadataForTenant('tenant-1');

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1' },
        select: [
          'id',
          'name',
          'fileType',
          'originalFileName',
          'fileSize',
          'mimeType',
          'status',
          'linkedEntityType',
          'linkedEntityId',
          'versionNumber',
          'uploadedById',
          'createdAt',
        ],
      }),
    );
    const [[call]] = find.mock.calls;
    expect(call.select).not.toEqual(expect.arrayContaining(['s3Url']));
    expect(call.select).not.toEqual(expect.arrayContaining(['rbac']));
    expect(call.select).not.toEqual(expect.arrayContaining(['aiAnalysis']));
  });

  it('scopes strictly to the requested tenant', async () => {
    findOne.mockResolvedValue({ id: 'tenant-2' });
    find.mockResolvedValue([]);

    await make().listMetadataForTenant('tenant-2');

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-2' } }),
    );
  });
});
