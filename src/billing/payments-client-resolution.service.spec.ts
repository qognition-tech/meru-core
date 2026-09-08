import { PaymentsService } from './payments.service';
import { PaymentDirection } from './entities/payment.entity';
import { User } from '../iam/entities/user.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import {
  EntityType,
  UniversalEntity,
} from '../crm/entities/universal-entity.entity';

/**
 * The defect this spec closes: the only UI that raises a charge (ImmiStack's
 * `/clients/:id` page, via `RequestPaymentDialog`) knows a client only as a
 * CRM `universal_entities.id` — a client is a Universal Entity of
 * `type: 'person'` before they are ever a `users` row. `Payment.clientId` is
 * documented, and enforced by `clientScope` in `PaymentsController`, to be
 * `users.id`. Left unresolved, every charge staff wrote stored an id that
 * could never equal a real client's `req.user.id`, so `GET /payments` and
 * `/payments/summary` came back empty for every real client login — always,
 * and silently: an honest-looking "nothing recorded" hiding a broken join
 * (CLAUDE.md §5.2).
 *
 * These tests drive `PaymentsService.create` — the one place resolution
 * happens — through a fake `DataSource` standing in for `users` and
 * `universal_entities`, and a `paymentRepo` fake real enough to answer
 * `findOne` from what `create` actually wrote, so "visible to the resolved
 * client, invisible to anyone else" is proven end to end rather than assumed.
 */
describe('PaymentsService — resolving clientId to a real user', () => {
  const TENANT = 't1';

  const build = (opts: {
    users?: Array<{
      id: string;
      tenantId: string;
      email: string;
      roles?: string[];
    }>;
    people?: Array<{
      id: string;
      tenantId: string;
      type: EntityType;
      email: string | null;
      firstName?: string;
    }>;
  }) => {
    // Every fixture user is a client unless a test says otherwise — the
    // negative case (a staff/admin id passed as clientId) sets `roles`
    // explicitly.
    const users = (opts.users ?? []).map((u) => ({
      roles: [PlatformRole.CLIENT],
      ...u,
    }));
    const people = opts.people ?? [];

    // Real enough to answer `findOne({ where })` the way TypeORM would —
    // every key in `where` must match — which is what lets the "visible to
    // the resolved client" tests below read back what `create` wrote.
    const rows: Array<Record<string, unknown>> = [];
    let nextId = 1;
    const paymentRepo = {
      create: (x: Record<string, unknown>) => x,
      save: (x: Record<string, unknown>) => {
        const row = { ...x, id: `p${nextId++}` };
        rows.push(row);
        return Promise.resolve(row);
      },
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.find((r) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
          ) ?? null,
        ),
    };

    const userRepo = {
      findOne: ({ where }: { where: { id: string; tenantId: string } }) =>
        Promise.resolve(
          users.find(
            (u) => u.id === where.id && u.tenantId === where.tenantId,
          ) ?? null,
        ),
      // Stands in for `.createQueryBuilder('u').where(...).andWhere('LOWER(u.email) = LOWER(:email)', ...)`
      // in resolveClientUserId — matches case-insensitively, same as the real
      // SQL, because neither side normalises email case on write.
      createQueryBuilder: () => {
        let tenantNeedle = '';
        let emailNeedle = '';
        const qb = {
          where: (_c: string, params: Record<string, unknown>) => {
            tenantNeedle = params.tenantId as string;
            return qb;
          },
          andWhere: (_c: string, params: Record<string, unknown>) => {
            emailNeedle = (params.email as string).toLowerCase();
            return qb;
          },
          getOne: () =>
            Promise.resolve(
              users.find(
                (u) =>
                  u.tenantId === tenantNeedle &&
                  u.email.toLowerCase() === emailNeedle,
              ) ?? null,
            ),
        };
        return qb;
      },
    };

    const personRepo = {
      findOne: ({
        where,
      }: {
        where: { id: string; tenantId: string; type: EntityType };
      }) =>
        Promise.resolve(
          people.find(
            (p) =>
              p.id === where.id &&
              p.tenantId === where.tenantId &&
              p.type === where.type,
          ) ?? null,
        ),
    };

    const dataSource = {
      getRepository: (entity: unknown) => {
        if (entity === User) return userRepo;
        if (entity === UniversalEntity) return personRepo;
        throw new Error(`unexpected repository requested in test: ${entity}`);
      },
    };

    const service = new PaymentsService(paymentRepo as any, dataSource as any);
    return { service, rows };
  };

  it('uses a real users.id as-is when that is what was sent', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
    });

    await service.create(TENANT, {
      clientId: 'user-1',
      amountMinor: 45000,
      currency: 'AUD',
      description: 'Consultation',
    } as never);

    expect(rows[0].clientId).toBe('user-1');
  });

  it('resolves a CRM person id to the users row sharing its email', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'ana@example.com',
          firstName: 'Ana',
        },
      ],
    });

    await service.create(TENANT, {
      clientId: 'person-1', // the id the client-detail page actually has
      amountMinor: 45000,
      currency: 'AUD',
      description: 'Application fee',
    } as never);

    // Stored under the REAL users.id, not the CRM entity id the caller sent —
    // this is the whole point: `clientScope` compares against `req.user.id`,
    // which is `user-1`, never `person-1`.
    expect(rows[0].clientId).toBe('user-1');
  });

  it('matches email case-insensitively — neither side normalises case on write', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'Ana@Example.com' }],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'ana@example.com',
        },
      ],
    });

    await service.create(TENANT, {
      clientId: 'person-1',
      amountMinor: 100,
      currency: 'AUD',
      description: 'Fee',
    } as never);

    expect(rows[0].clientId).toBe('user-1');
  });

  it('refuses the write when the person has never been invited, rather than storing an unresolvable id', async () => {
    const { service, rows } = build({
      users: [],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'not-yet-invited@example.com',
          firstName: 'Bilal',
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/has not been invited yet/);

    // The earlier failure mode was a row saved with an id nothing could ever
    // match. The fix is not to save a different, still-wrong id — it is to
    // refuse the write. No row at all.
    expect(rows).toHaveLength(0);
  });

  it('404s a clientId that names neither a user nor a person record', async () => {
    const { service } = build({});

    await expect(
      service.create(TENANT, {
        clientId: 'nothing-here',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/no client with that id/i);
  });

  it('refuses a person record with no email — nothing to match a user by', async () => {
    const { service } = build({
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: null,
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/no email on file/);
  });

  it('refuses a staff id passed as clientId rather than resolving it as-is', async () => {
    // The direct-`users.id` fast path used to accept ANY user in the tenant.
    // A charge raised against a colleague's id by typo would then appear in
    // that colleague's own `GET /payments` — `Payment.clientId` is the
    // authorisation key for a client's ledger, and a staff id defeats that
    // by construction.
    const { service, rows } = build({
      users: [{ id: 'staff-1', tenantId: TENANT, email: 'staff@example.com', roles: [PlatformRole.STAFF] }],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'staff-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/not a client/i);

    expect(rows).toHaveLength(0);
  });

  it('refuses a firm_admin id passed as clientId, same as staff', async () => {
    const { service, rows } = build({
      users: [
        {
          id: 'admin-1',
          tenantId: TENANT,
          email: 'admin@example.com',
          roles: [PlatformRole.FIRM_ADMIN],
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'admin-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/not a client/i);

    expect(rows).toHaveLength(0);
  });

  describe('what each login can see, once the id resolves correctly', () => {
    it("a charge raised against a CRM person id is visible to that person's own client login", async () => {
      const { service, rows } = build({
        users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      const created = await service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 45000,
        currency: 'AUD',
        description: 'Application fee',
      } as never);

      // `clientScope` forces a client-role caller's own `req.user.id` in here
      // as `forceClientId` — reproduced directly rather than through the
      // controller, since the controller is not part of this defect.
      await expect(
        service.findOne(TENANT, created.id, 'user-1'),
      ).resolves.toMatchObject({ id: created.id });
      expect(rows).toHaveLength(1);
    });

    it('a client still cannot see another client\'s charge, even though the row resolved cleanly', async () => {
      const { service } = build({
        users: [
          { id: 'user-1', tenantId: TENANT, email: 'ana@example.com' },
          { id: 'user-2', tenantId: TENANT, email: 'ben@example.com' },
        ],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      const created = await service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 45000,
        currency: 'AUD',
        description: 'Application fee',
      } as never);

      // Ben asking for Ana's payment gets 404, not 403 — same as before this
      // fix, and unaffected by where the id came from.
      await expect(
        service.findOne(TENANT, created.id, 'user-2'),
      ).rejects.toThrow(/not found/i);
    });

    it('a client still sees inbound only — a resolved clientId does not override the direction rule', async () => {
      const { service } = build({
        users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      // Not a realistic charge (outbound rows carry no client), but the point
      // is narrow: even if a resolved clientId ends up on an outbound row,
      // the direction check in findOne still applies to it.
      const created = await service.create(TENANT, {
        clientId: 'person-1',
        direction: PaymentDirection.OUTBOUND,
        payee: 'Department of Home Affairs',
        amountMinor: 305000,
        currency: 'AUD',
        description: 'Government charge forwarded',
      } as never);

      await expect(
        service.findOne(TENANT, created.id, 'user-1'),
      ).rejects.toThrow(/not found/i);

      // Staff, with no forced scope, still sees it.
      await expect(
        service.findOne(TENANT, created.id, null),
      ).resolves.toMatchObject({ id: created.id });
    });
  });
});
