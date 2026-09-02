import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FormBuilderService } from './form-builder.service';
import { FormLayout, FormStatus } from './entities/form-schema.entity';
import { CreateFormDto } from './dto/create-form.dto';

/**
 * `forms` shipped with zero specs before this pass. Two independent bugs
 * lived here:
 *
 *  1. `getForm(id)` took no `tenantId` at all — `findOne({ where: { id } })`
 *     — so any form schema in any tenant resolved by id alone. RLS is
 *     verified enforced in production for `form_schemas` (`rls=true,
 *     force=true`), so this was defence-in-depth, not the live leak an
 *     earlier report claimed; it is fixed anyway, same as every other
 *     unscoped-by-id method this codebase has closed.
 *
 *  2. `POST /forms`'s `layout` field required `@IsObject()` while the
 *     column it fills (`form_schemas.layout`) is a Postgres enum
 *     (`FormLayout`) — so the endpoint was unreachable: every shape a
 *     caller could send either failed validation or blew up the insert.
 */
describe('FormBuilderService.getForm — tenant scope', () => {
  const T = 't1';
  const OTHER_T = 't2';
  const FORM_ID = 'form-1';

  function buildService() {
    const store = new Map<string, any>();
    store.set(FORM_ID, {
      id: FORM_ID,
      tenantId: T,
      name: 'Subclass 482 nomination',
      entityType: 'case',
      layout: FormLayout.SINGLE_COLUMN,
      status: FormStatus.DRAFT,
      version: 1,
      fields: [],
    });

    const formSchemaRepo = {
      findOne: async ({ where }: any) => {
        let rows = [...store.values()];
        if (where.id !== undefined) rows = rows.filter((r) => r.id === where.id);
        if (where.tenantId !== undefined)
          rows = rows.filter((r) => r.tenantId === where.tenantId);
        return rows[0] ?? null;
      },
    };

    const unused = {} as any;
    return new FormBuilderService(
      formSchemaRepo as any,
      unused, // formFieldRepo
      unused, // submissionRepo
      unused, // dataSource
      unused, // searchService
      unused, // aiService
      unused, // documentHubService
    );
  }

  it('returns the form for the tenant that owns it', async () => {
    const service = buildService();
    const form = await service.getForm(FORM_ID, T);
    expect(form.id).toBe(FORM_ID);
  });

  it('404s — not a wrong-tenant row — when the id belongs to a different tenant', async () => {
    const service = buildService();
    await expect(service.getForm(FORM_ID, OTHER_T)).rejects.toThrow(NotFoundException);
  });

  it('404s on an id that does not exist at all, same shape as a wrong-tenant id', async () => {
    const service = buildService();
    await expect(service.getForm('no-such-form', T)).rejects.toThrow(NotFoundException);
  });
});

describe('CreateFormDto.layout — matches the entity column, not a JSON blob', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(CreateFormDto, body);
    return validate(dto);
  }

  const validBody = {
    name: 'Subclass 482 nomination',
    entityType: 'case',
    fields: [],
  };

  it('rejects the shape the field used to demand — an object — now that the column is an enum', async () => {
    const errors = await errorsFor({ ...validBody, layout: {} });
    expect(errors.some((e) => e.property === 'layout')).toBe(true);
  });

  it('rejects a missing layout', async () => {
    const errors = await errorsFor({ ...validBody });
    expect(errors.some((e) => e.property === 'layout')).toBe(true);
  });

  it('rejects a layout value the enum does not carry', async () => {
    const errors = await errorsFor({ ...validBody, layout: 'not_a_real_layout' });
    expect(errors.some((e) => e.property === 'layout')).toBe(true);
  });

  it('accepts every layout the entity actually stores', async () => {
    for (const layout of Object.values(FormLayout)) {
      const errors = await errorsFor({ ...validBody, layout });
      expect(errors.some((e) => e.property === 'layout')).toBe(false);
    }
  });
});
