import { CrmService } from './crm.service';
import { EntityStatus, EntityType } from './entities/universal-entity.entity';

/**
 * Lead conversion has to keep the record's id.
 *
 * `PATCH /crm/entities/:id` refuses `type`, so the frontend created a new
 * `person` and marked the lead resolved. The client then had a new id, and every
 * comment, document, task, payment and message filed during intake stayed
 * attached to a row the UI no longer shows — the discontinuity the one-generic-
 * record design exists to prevent, caused by a missing route.
 */
describe('CrmService.convertEntity', () => {
  const build = (entity: Record<string, any> | null) => {
    const saved: Record<string, any>[] = [];
    const entityRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn((e: Record<string, any>) => {
        saved.push({ ...e });
        return Promise.resolve(e);
      }),
    };
    const searchService = { indexEntityData: jest.fn().mockResolvedValue(undefined) };
    const service = new CrmService(
      entityRepo as any,
      {} as any,
      searchService as any,
      {} as any,
      {} as any,
    );
    return { service, saved, entityRepo, searchService };
  };

  const lead = (over: Record<string, any> = {}) => ({
    id: 'e1',
    tenantId: 't1',
    type: EntityType.LEAD,
    status: EntityStatus.OPEN,
    verticalAttributes: {
      lead: { fields: { first_name: 'Priya', last_name: 'Sharma' } },
    },
    ...over,
  });

  it('keeps the same id, so history stays attached', async () => {
    const { service, saved } = build(lead());
    const result = await service.convertEntity('e1', 't1', EntityType.PERSON);

    expect(result.id).toBe('e1');
    expect(saved[0].type).toBe(EntityType.PERSON);
  });

  it('does not lose the attributes gathered during intake', async () => {
    const { service } = build(lead());
    const result = await service.convertEntity('e1', 't1', EntityType.PERSON);

    expect(result.verticalAttributes.lead.fields).toEqual({
      first_name: 'Priya',
      last_name: 'Sharma',
    });
  });

  it('records what it used to be', async () => {
    const { service } = build(lead());
    const result = await service.convertEntity('e1', 't1', EntityType.PERSON);

    expect(result.verticalAttributes.conversion).toMatchObject({
      fromType: EntityType.LEAD,
      toType: EntityType.PERSON,
    });
    expect(result.verticalAttributes.conversion.convertedAt).toBeTruthy();
  });

  it('clears status when the new type has no lifecycle', async () => {
    // A person is reference data. Keeping `status: open` would leave a value
    // that reads as meaningful and is not.
    const { service } = build(lead());
    const result = await service.convertEntity('e1', 't1', EntityType.PERSON);
    expect(result.status).toBeNull();
  });

  it('leaves reference types without a status in either direction', async () => {
    // Every transition the allowlist currently permits targets reference data
    // (person, organization), so `status` always clears. The workable-type
    // branch in `convertEntity` is defensive, for when the allowlist grows —
    // there is no permitted conversion that exercises it today, and a test
    // claiming otherwise would be asserting nothing.
    const { service } = build({ ...lead(), type: EntityType.PERSON, status: null });
    const result = await service.convertEntity('e1', 't1', EntityType.ORGANIZATION);
    expect(result.status).toBeNull();
  });

  it('re-indexes, so filtered lists stop answering to the old type', async () => {
    const { service, searchService } = build(lead());
    await service.convertEntity('e1', 't1', EntityType.PERSON);
    expect(searchService.indexEntityData).toHaveBeenCalled();
  });

  it('404s on a record that is not this tenant\'s', async () => {
    const { service } = build(null);
    await expect(
      service.convertEntity('e1', 't1', EntityType.PERSON),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a conversion to the type it already is', async () => {
    const { service } = build(lead());
    await expect(
      service.convertEntity('e1', 't1', EntityType.LEAD),
    ).rejects.toThrow(/already of type/i);
  });

  it('refuses a nonsensical transition and names what is allowed', async () => {
    const { service } = build(lead());
    // A lead is not a case. Left open, the id would keep the mistake alive.
    await expect(
      service.convertEntity('e1', 't1', EntityType.CASE),
    ).rejects.toThrow(/Cannot convert 'lead' to 'case'.*person|organization/s);
  });

  it('refuses to convert a type with no permitted transitions at all', async () => {
    const { service } = build({ ...lead(), type: EntityType.CASE });
    await expect(
      service.convertEntity('e1', 't1', EntityType.PERSON),
    ).rejects.toThrow(/may become: nothing/);
  });

  it('does not write anything when the transition is refused', async () => {
    const { service, entityRepo } = build(lead());
    await expect(
      service.convertEntity('e1', 't1', EntityType.CASE),
    ).rejects.toThrow();
    expect(entityRepo.save).not.toHaveBeenCalled();
  });
});
