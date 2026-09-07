import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Payment,
  PaymentDirection,
  PaymentStatus,
} from './entities/payment.entity';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  SettlePaymentDto,
} from './dto/payment.dto';
import { User } from '../iam/entities/user.entity';
import {
  EntityType,
  UniversalEntity,
} from '../crm/entities/universal-entity.entity';

/**
 * The firm's receivables ledger — what its clients owe it for services.
 *
 * **No payment processor is involved, by design.** Stripe in this platform is
 * Meru collecting subscription money *from* tenants (that is BILL:
 * `subscriptions`, `invoices`, `/billing/checkout`). A firm collects its own
 * client fees through its own arrangements — bank transfer, card terminal,
 * trust account — and records the settlement here. Wiring client fees through
 * the platform's Stripe key would settle a client's visa fee into Meru's
 * balance, which is a silent financial misroute, and doing it properly would
 * mean Stripe Connect, money-transmission licensing and holding client funds.
 * This table records money; it never moves it.
 *
 * Two rules run through everything here:
 *
 * 1. **Money is integer minor units.** The column is `bigint`, so TypeORM
 *    returns a string; it is converted at the edge and never becomes a float
 *    mid-calculation.
 * 2. **A client sees only their own rows.** RLS separates tenants and nothing
 *    else, so every read path takes an explicit `clientId` restriction — the
 *    same defect class as the CRM leak fixed in 32147ed, where a client token
 *    received every case in the firm.
 * 3. **`clientId` is written, not merely read, as a real `users.id`.** The UI
 *    that raises a charge knows a client only as a CRM entity id, so every
 *    write resolves that to the matching `users` row first — see
 *    {@link resolveClientUserId}. Without it, rule 2 enforces an id nothing
 *    could ever satisfy: the client's ledger was correctly restricted to an
 *    id that never matched, which read as "no charges" rather than "broken".
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    // Not `@InjectRepository(User)` / `@InjectRepository(UniversalEntity)`:
    // both entities are already in the global `ALL_ENTITIES` catalogue
    // (src/config/entities.ts), so a plain `DataSource.getRepository` reaches
    // them without wiring `BillingModule` into `IamModule` and `CrmModule` —
    // same pattern as `TenantProvisioningService` (tenant-provisioning.service.ts:429).
    // Used only by {@link resolveClientUserId}.
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** `bigint` arrives as a string. Expose a number, and never compute on it. */
  private present(p: Payment) {
    return {
      ...p,
      amountMinor: Number(p.amountMinor),
    };
  }

  /**
   * Resolve whatever id staff supplied as `clientId` to a real `users.id`.
   *
   * `Payment.clientId` is documented as `users.id` because it is the
   * authorisation key that keeps one client's ledger from another's — see the
   * doc comment on the column. But the only UI that raises a charge
   * (ImmiStack's `RequestPaymentDialog`, via the `/clients/:id` page) knows a
   * client only as a CRM `universal_entities.id`: a client is a Universal
   * Entity of `type: 'person'`, and their IAM `users` row — created later, by
   * `IamService.inviteUser`, once someone gets around to inviting them — carries
   * no column linking back to it. Email is the only attribute both sides share.
   *
   * Left unresolved, every charge staff raised stored an id that could never
   * equal any real client's `req.user.id`, so `GET /payments` and
   * `/payments/summary` returned empty for every client login — forever, and
   * silently: an honest-looking "nothing here" hiding a broken join
   * (CLAUDE.md §5.2, "unknown is never clear").
   *
   * Resolution order, cheapest and most certain first:
   *
   * 1. `clientId` already names a `users` row in this tenant — the documented,
   *    correct shape. Used as-is, so a caller that already gets this right
   *    (or a future one that does) pays no extra query and changes no
   *    behaviour.
   * 2. `clientId` names a CRM person entity in this tenant. Resolve to the
   *    `users` row sharing its email, compared case-insensitively: neither
   *    `users.email` nor `universal_entities.email` is normalised on write
   *    anywhere in this codebase (checked `IamService.inviteUser` and
   *    `CrmService.createEntity`), so the comparison has to be, not the
   *    storage — the same reasoning `CrmAccessService.ownsEntity` uses for
   *    the equivalent `subjectEmail` comparison.
   * 3. The person exists but nobody has invited them — there is no `users`
   *    row to authorise against. Storing `clientId: null` would make the
   *    charge invisible to *every* client, which is this exact bug, only
   *    earlier. **Refused (400)** with a message that says what to do,
   *    rather than silently recording a charge nobody can ever be shown.
   * 4. Neither a user nor a person record exists with this id in this tenant —
   *    a bad id, not a timing issue. **404**, matching how every other id
   *    lookup in this controller treats "does not exist here".
   */
  /**
   * Public because `FeeScheduleService.expand` writes `Payment` rows on a
   * second path and must resolve the same way — see the note on
   * `Payment.clientId`. Two writers storing two different id spaces into one
   * authorisation column is how this defect existed at all.
   */
  async resolveClientUserId(
    tenantId: string,
    clientId: string,
  ): Promise<string> {
    const userRepo = this.dataSource.getRepository(User);

    const directUser = await userRepo.findOne({
      where: { id: clientId, tenantId },
    });
    if (directUser) return directUser.id;

    const person = await this.dataSource.getRepository(UniversalEntity).findOne({
      where: { id: clientId, tenantId, type: EntityType.PERSON },
    });

    if (!person) {
      throw new NotFoundException(
        'No client with that id in this tenant — not a users.id, and not a ' +
          'person record either',
      );
    }

    if (!person.email) {
      throw new BadRequestException(
        `${person.firstName ?? 'This client'}'s record has no email on file, ` +
          'so there is no way to find — or ever notify — the account this ' +
          'charge would belong to. Add an email to the client record first.',
      );
    }

    // Case-insensitive by comparison, not by index: see the method doc for why.
    const user = await userRepo
      .createQueryBuilder('u')
      .where('u."tenantId" = :tenantId', { tenantId })
      .andWhere('LOWER(u.email) = LOWER(:email)', { email: person.email })
      .getOne();

    if (!user) {
      throw new BadRequestException(
        `${person.firstName ?? 'This client'} has not been invited yet, so ` +
          'there is no account for this charge to belong to. Invite them ' +
          '(POST /iam/users/invite) before raising a charge — otherwise the ' +
          "charge would be recorded but could never appear in anyone's portal.",
      );
    }

    return user.id;
  }

  async list(
    tenantId: string,
    query: ListPaymentsQueryDto,
    /** Non-null forces the result to one client, whatever the query asked. */
    forceClientId: string | null,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;

    const qb = this.paymentRepo
      .createQueryBuilder('p')
      .where('p."tenantId" = :tenantId', { tenantId });

    // The forced value overwrites rather than combines: a client must not be
    // able to widen their view by passing ?clientId= for somebody else.
    const clientId = forceClientId ?? query.clientId;
    if (clientId) qb.andWhere('p."clientId" = :clientId', { clientId });

    // A client sees receivables only. Outbound rows are the firm's own
    // expenditure — what it paid the Department, what it spent on a police
    // check — and none of that is the client's business even on their own
    // matter. Forced, not defaulted, so `?direction=outbound` cannot widen it.
    const direction = forceClientId
      ? PaymentDirection.INBOUND
      : query.direction;
    if (direction) qb.andWhere('p."direction" = :direction', { direction });

    if (query.status)
      qb.andWhere('p.status = :status', { status: query.status });
    if (query.entityId)
      qb.andWhere('p."entityId" = :entityId', { entityId: query.entityId });

    const [items, total] = await qb
      .orderBy('p."createdAt"', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: items.map((p) => this.present(p)), total, page, limit };
  }

  /**
   * Ledger totals by currency and status.
   *
   * A separate call rather than a field on the list response: the envelope
   * interceptor replaces a paginated payload with its `items` array, so any
   * sibling key is silently discarded — the totals would simply never reach
   * the client, with nothing to indicate they had been dropped.
   *
   * Summed in SQL across the whole filtered ledger, never over the current
   * page. A client portal renders this as "outstanding", and a page-local sum
   * would quietly mean "outstanding on page 1".
   *
   * Grouped by currency because summing mixed currencies produces a number
   * that looks authoritative and means nothing.
   */
  async summary(
    tenantId: string,
    query: ListPaymentsQueryDto,
    forceClientId: string | null,
  ) {
    const qb = this.paymentRepo
      .createQueryBuilder('p')
      .where('p."tenantId" = :tenantId', { tenantId });

    const clientId = forceClientId ?? query.clientId;
    if (clientId) qb.andWhere('p."clientId" = :clientId', { clientId });
    if (query.entityId)
      qb.andWhere('p."entityId" = :entityId', { entityId: query.entityId });

    const direction = forceClientId
      ? PaymentDirection.INBOUND
      : query.direction;
    if (direction) qb.andWhere('p."direction" = :direction', { direction });

    const rows = await qb
      .select('p.currency', 'currency')
      .addSelect('p.status', 'status')
      .addSelect('p.direction', 'direction')
      .addSelect('SUM(p."amountMinor")', 'sum')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.currency')
      .addGroupBy('p.status')
      .addGroupBy('p.direction')
      .getRawMany<{
        currency: string;
        status: PaymentStatus;
        direction: PaymentDirection;
        sum: string;
        count: string;
      }>();

    // `direction` is part of every group key, never summed across. A total that
    // added forwarded government charges to the firm's fees would overstate
    // revenue by exactly the amount the firm never earned.
    const byStatus = rows.map((r) => ({
      currency: r.currency,
      status: r.status,
      direction: r.direction,
      amountMinor: Number(r.sum),
      count: Number(r.count),
    }));

    const totalFor = (d: PaymentDirection) =>
      byStatus
        .filter((r) => r.direction === d)
        .reduce<Record<string, number>>((acc, r) => {
          acc[r.currency] = (acc[r.currency] ?? 0) + r.amountMinor;
          return acc;
        }, {});

    return {
      byStatus,
      // Per currency, per direction. Kept separate for the same reason the
      // grouping is: these two numbers must never be added together.
      receivableMinor: totalFor(PaymentDirection.INBOUND),
      payableMinor: totalFor(PaymentDirection.OUTBOUND),
    };
  }

  async findOne(tenantId: string, id: string, forceClientId: string | null) {
    const payment = await this.paymentRepo.findOne({ where: { tenantId, id } });
    // A client asking for another client's payment gets 404, not 403. A 403
    // confirms the row exists, which leaks the shape of someone else's ledger
    // to anyone willing to enumerate ids.
    if (
      !payment ||
      (forceClientId &&
        (payment.clientId !== forceClientId ||
          payment.direction !== PaymentDirection.INBOUND))
    ) {
      throw new NotFoundException('Payment not found');
    }
    return this.present(payment);
  }

  /**
   * Record a receivable, or a disbursement the firm owes.
   *
   * An outbound row needs a `payee` and needs no `clientId`: the firm paying the
   * Department for a client's application names the client, but an annual
   * registration fee has no client and must not be attributed to whichever
   * applicant was handy.
   */
  async create(tenantId: string, dto: CreatePaymentDto) {
    const direction = dto.direction ?? PaymentDirection.INBOUND;

    if (direction === PaymentDirection.INBOUND && !dto.clientId) {
      throw new BadRequestException(
        'clientId is required for an inbound payment — somebody has to owe it',
      );
    }
    if (direction === PaymentDirection.OUTBOUND && !dto.payee) {
      throw new BadRequestException(
        'payee is required for an outbound payment — a disbursement to nobody is not a record',
      );
    }

    // `dto.clientId` may name a real `users.id` or the CRM person entity the
    // caller actually has to hand — see resolveClientUserId's doc comment.
    // Resolved once, here, so every row this method ever writes stores a real
    // `users.id` or nothing; there is no path that stores an id that can
    // never match a real login.
    const clientId = dto.clientId
      ? await this.resolveClientUserId(tenantId, dto.clientId)
      : null;

    const payment = this.paymentRepo.create({
      tenantId,
      clientId,
      entityId: dto.entityId ?? null,
      direction,
      payee: dto.payee ?? null,
      amountMinor: String(dto.amountMinor),
      currency: dto.currency.toUpperCase(),
      description: dto.description,
      reference: dto.reference ?? null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      feeKind: dto.feeKind ?? null,
      status: PaymentStatus.PENDING,
    });
    return this.present(await this.paymentRepo.save(payment));
  }

  /**
   * Record that a payment settled (or failed, or was refunded) outside Meru.
   *
   * Staff-only, and the transitions are constrained rather than free-form: a
   * ledger that lets anything become anything cannot be reconciled, and
   * "paid → pending" is not a correction, it is a lost audit trail. Reversing
   * a settled payment is a refund, which is its own row-state, not an edit.
   */
  async settle(tenantId: string, id: string, dto: SettlePaymentDto) {
    const payment = await this.paymentRepo.findOne({ where: { tenantId, id } });
    if (!payment) throw new NotFoundException('Payment not found');

    const allowed: Record<PaymentStatus, PaymentStatus[]> = {
      [PaymentStatus.PENDING]: [
        PaymentStatus.PAID,
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
      ],
      [PaymentStatus.FAILED]: [
        PaymentStatus.PAID,
        PaymentStatus.PENDING,
        PaymentStatus.CANCELLED,
      ],
      [PaymentStatus.PAID]: [PaymentStatus.REFUNDED],
      [PaymentStatus.REFUNDED]: [],
      [PaymentStatus.CANCELLED]: [],
    };

    if (!allowed[payment.status].includes(dto.status)) {
      throw new BadRequestException(
        `Cannot move a ${payment.status} payment to ${dto.status}` +
          (allowed[payment.status].length
            ? `. Allowed: ${allowed[payment.status].join(', ')}`
            : ' — this is a terminal state'),
      );
    }

    payment.status = dto.status;
    payment.paidAt =
      dto.status === PaymentStatus.PAID
        ? (payment.paidAt ?? new Date())
        : payment.paidAt;
    payment.metadata = {
      ...(payment.metadata ?? {}),
      // How the money actually arrived. Free text on purpose: the set of
      // methods is a firm's business, not something core should enumerate.
      ...(dto.method ? { method: dto.method } : {}),
      ...(dto.note ? { note: dto.note } : {}),
    };
    if (dto.reference !== undefined) payment.reference = dto.reference;

    return this.present(await this.paymentRepo.save(payment));
  }
}
