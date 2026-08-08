import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment, PaymentStatus } from './entities/payment.entity';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  SettlePaymentDto,
} from './dto/payment.dto';

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
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
  ) {}

  /** `bigint` arrives as a string. Expose a number, and never compute on it. */
  private present(p: Payment) {
    return {
      ...p,
      amountMinor: Number(p.amountMinor),
    };
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

    if (query.status) qb.andWhere('p.status = :status', { status: query.status });
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

    const rows = await qb
      .select('p.currency', 'currency')
      .addSelect('p.status', 'status')
      .addSelect('SUM(p."amountMinor")', 'sum')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.currency')
      .addGroupBy('p.status')
      .getRawMany<{
        currency: string;
        status: PaymentStatus;
        sum: string;
        count: string;
      }>();

    return {
      byStatus: rows.map((r) => ({
        currency: r.currency,
        status: r.status,
        amountMinor: Number(r.sum),
        count: Number(r.count),
      })),
    };
  }

  async findOne(tenantId: string, id: string, forceClientId: string | null) {
    const payment = await this.paymentRepo.findOne({ where: { tenantId, id } });
    // A client asking for another client's payment gets 404, not 403. A 403
    // confirms the row exists, which leaks the shape of someone else's ledger
    // to anyone willing to enumerate ids.
    if (!payment || (forceClientId && payment.clientId !== forceClientId)) {
      throw new NotFoundException('Payment not found');
    }
    return this.present(payment);
  }

  async create(tenantId: string, dto: CreatePaymentDto) {
    const payment = this.paymentRepo.create({
      tenantId,
      clientId: dto.clientId,
      entityId: dto.entityId ?? null,
      amountMinor: String(dto.amountMinor),
      currency: dto.currency.toUpperCase(),
      description: dto.description,
      reference: dto.reference ?? null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
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
      dto.status === PaymentStatus.PAID ? (payment.paidAt ?? new Date()) : payment.paidAt;
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
