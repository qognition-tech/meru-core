import { PaymentsService } from './payments.service';
import { PaymentDirection, PaymentStatus } from './entities/payment.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * Money out, and the two things that must not happen once it exists.
 *
 * The firm paying the Department's charge is half the lodgement step and had no
 * row type, so the frontend recorded it as a file note — writing it as a payment
 * would have inflated revenue by every government fee the firm ever forwarded.
 *
 * Adding it creates two new ways to be wrong: totalling receivables together
 * with expenditure, and showing a client what the firm spends. Both are checked
 * here, because both are silent.
 */
describe('PaymentsService — disbursements', () => {
  const build = (rows: Array<Record<string, unknown>> = []) => {
    const captured: { where: string[]; params: Record<string, unknown> } = {
      where: [],
      params: {},
    };
    const saved: Array<Record<string, unknown>> = [];

    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      where: (clause: string, params?: Record<string, unknown>) => {
        captured.where.push(clause);
        Object.assign(captured.params, params ?? {});
        return qb;
      },
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        captured.where.push(clause);
        Object.assign(captured.params, params ?? {});
        return qb;
      },
      select: () => qb,
      addSelect: () => qb,
      groupBy: () => qb,
      addGroupBy: () => qb,
      orderBy: () => qb,
      skip: () => qb,
      take: () => qb,
      getManyAndCount: () => Promise.resolve([[], 0]),
      getRawMany: () => Promise.resolve(rows),
    });

    const paymentRepo = {
      createQueryBuilder: () => qb,
      findOne: jest.fn(),
      create: (x: Record<string, unknown>) => x,
      save: (x: Record<string, unknown>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: 'p1' });
      },
    };

    // These tests are about direction, not id resolution — that gets its own
    // spec (payments-client-resolution.service.spec.ts). Stub the resolver's
    // fast path (clientId already names a `users` row) to always hit, so
    // `create()` behaves exactly as it did before resolution existed.
    //
    // The stub user must carry `client` in `roles`: `resolveClientUserId`
    // refuses an id belonging to a staff account, because a charge raised
    // against a colleague would land in that colleague's own ledger. A
    // role-less stub is indistinguishable from a staff id to that check.
    const dataSource = {
      getRepository: () => ({
        findOne: ({ where }: { where: { id: string; tenantId: string } }) =>
          Promise.resolve({
            id: where.id,
            tenantId: where.tenantId,
            email: 'stub@test.example',
            roles: [PlatformRole.CLIENT],
          }),
      }),
    };

    const service = new PaymentsService(paymentRepo as any, dataSource as any);
    return { service, captured, saved, paymentRepo };
  };

  describe('creating one', () => {
    it('records who was paid', async () => {
      const { service, saved } = build();
      await service.create('t1', {
        direction: PaymentDirection.OUTBOUND,
        payee: 'Department of Home Affairs',
        entityId: 'case-1',
        amountMinor: 305000,
        currency: 'aud',
        description: 'Subclass 482 application charge',
        feeKind: 'government',
      } as never);

      expect(saved[0].direction).toBe(PaymentDirection.OUTBOUND);
      expect(saved[0].payee).toBe('Department of Home Affairs');
      expect(saved[0].clientId).toBeNull();
      expect(saved[0].currency).toBe('AUD');
    });

    it('refuses a disbursement to nobody', async () => {
      // "We paid AUD 3,050.00 to (blank)" is not a record of anything.
      const { service } = build();
      await expect(
        service.create('t1', {
          direction: PaymentDirection.OUTBOUND,
          amountMinor: 305000,
          currency: 'AUD',
          description: 'Application charge',
        } as never),
      ).rejects.toThrow(/payee is required/);
    });

    it('still requires a client for a receivable', async () => {
      const { service } = build();
      await expect(
        service.create('t1', {
          amountMinor: 45000,
          currency: 'AUD',
          description: 'Professional fees',
        } as never),
      ).rejects.toThrow(/clientId is required/);
    });

    it('defaults to inbound, so existing callers are unaffected', async () => {
      const { service, saved } = build();
      await service.create('t1', {
        clientId: 'c1',
        amountMinor: 45000,
        currency: 'AUD',
        description: 'Professional fees',
      } as never);
      expect(saved[0].direction).toBe(PaymentDirection.INBOUND);
    });
  });

  describe('what a client may see', () => {
    it('confines a client to inbound rows', async () => {
      const { service, captured } = build();
      await service.list('t1', {} as never, 'client-1');

      expect(captured.where.some((w) => w.includes('"direction"'))).toBe(true);
      expect(captured.params.direction).toBe(PaymentDirection.INBOUND);
      expect(captured.params.clientId).toBe('client-1');
    });

    it('does not let a client widen to outbound via the query', async () => {
      // The firm's expenditure is not the client's business even on their own
      // matter. Forced, not defaulted.
      const { service, captured } = build();
      await service.list(
        't1',
        { direction: PaymentDirection.OUTBOUND } as never,
        'client-1',
      );
      expect(captured.params.direction).toBe(PaymentDirection.INBOUND);
    });

    it('lets staff ask for either, or both', async () => {
      const both = build();
      await both.service.list('t1', {} as never, null);
      expect(both.captured.params.direction).toBeUndefined();

      const out = build();
      await out.service.list(
        't1',
        { direction: PaymentDirection.OUTBOUND } as never,
        null,
      );
      expect(out.captured.params.direction).toBe(PaymentDirection.OUTBOUND);
    });

    it("404s a client fetching the firm's disbursement by id", async () => {
      const { service, paymentRepo } = build();
      paymentRepo.findOne.mockResolvedValue({
        id: 'p1',
        tenantId: 't1',
        clientId: 'client-1',
        direction: PaymentDirection.OUTBOUND,
      });

      // Their own clientId is on the row, so the client check alone would have
      // let this through.
      await expect(service.findOne('t1', 'p1', 'client-1')).rejects.toThrow(
        /not found/i,
      );
    });

    it('lets a client fetch their own receivable', async () => {
      const { service, paymentRepo } = build();
      paymentRepo.findOne.mockResolvedValue({
        id: 'p1',
        tenantId: 't1',
        clientId: 'client-1',
        direction: PaymentDirection.INBOUND,
        amountMinor: '45000',
      });
      await expect(
        service.findOne('t1', 'p1', 'client-1'),
      ).resolves.toMatchObject({ id: 'p1', amountMinor: 45000 });
    });
  });

  describe('totals', () => {
    const rows = [
      {
        currency: 'AUD',
        status: PaymentStatus.PAID,
        direction: PaymentDirection.INBOUND,
        sum: '350000',
        count: '1',
      },
      {
        currency: 'AUD',
        status: PaymentStatus.PENDING,
        direction: PaymentDirection.INBOUND,
        sum: '45000',
        count: '1',
      },
      {
        currency: 'AUD',
        status: PaymentStatus.PAID,
        direction: PaymentDirection.OUTBOUND,
        sum: '305000',
        count: '1',
      },
    ];

    it('never adds expenditure to revenue', async () => {
      // The failure this whole change exists to avoid: 700000 would be the
      // firm's revenue plus a government charge it merely forwarded.
      const { service } = build(rows);
      const out = await service.summary('t1', {} as never, null);

      expect(out.receivableMinor).toEqual({ AUD: 395000 });
      expect(out.payableMinor).toEqual({ AUD: 305000 });
    });

    it('keeps direction in every group key', async () => {
      const { service } = build(rows);
      const out = await service.summary('t1', {} as never, null);
      expect(out.byStatus.every((r) => r.direction !== undefined)).toBe(true);
    });

    it('groups by currency, because mixed-currency sums mean nothing', async () => {
      const { service } = build([
        ...rows,
        {
          currency: 'AED',
          status: PaymentStatus.PENDING,
          direction: PaymentDirection.INBOUND,
          sum: '100000',
          count: '1',
        },
      ]);
      const out = await service.summary('t1', {} as never, null);
      expect(out.receivableMinor).toEqual({ AUD: 395000, AED: 100000 });
    });

    it("excludes disbursements from a client's summary", async () => {
      const { service, captured } = build(rows);
      await service.summary('t1', {} as never, 'client-1');
      expect(captured.params.direction).toBe(PaymentDirection.INBOUND);
    });
  });
});
