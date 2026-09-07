import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { PaymentsService } from './payments.service';

/** One `fees[]` entry, as the pack declares it. */
export interface FeeDefinition {
  key: string;
  label: string;
  kind?: 'government' | 'firm' | 'disbursement';
  amountMinor: number;
  currency: string;
  basis?: 'per_case' | 'per_applicant' | 'per_dependent';
  refundable?: boolean;
  reference?: string;
  atStep?: string;
}

/** One `paymentPlans[]` entry, as the pack declares it. */
export interface PaymentPlanDefinition {
  key: string;
  label: string;
  type?: 'upfront' | 'installments' | 'stage_gated';
  installmentCount?: number;
  intervalDays?: number;
  stages?: Array<{ atStep: string; portionBps: number; label?: string }>;
  blockProgressOnArrears?: boolean;
}

export interface ExpandRequest {
  tenantId: string;
  vertical: string | null;
  /** `universal_entities.id` — the case these fees belong to. */
  entityId: string;
  /** `users.id` of the client who owes them. */
  clientId: string;
  /** `fees[].key` values to charge. */
  feeKeys: string[];
  /** `paymentPlans[].key`, or none for a single payment per fee. */
  planKey?: string;
  /** Multiplier for `per_applicant` fees. */
  applicants?: number;
  /** Multiplier for `per_dependent` fees. */
  dependents?: number;
  /** Instalment clocks run from here. */
  startDate?: Date;
  reference?: string;
}

/**
 * Turns a pack's `fees[]` and `paymentPlans[]` into real payable rows.
 *
 * The vertical declares what things cost and how they may be paid; core knows
 * only how to expand a schedule and how to keep the arithmetic exact. No visa
 * subclass or licence category reaches this file.
 */
@Injectable()
export class FeeScheduleService {
  private readonly logger = new Logger(FeeScheduleService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly packs: VerticalPackService,
    // `Payment.clientId` is `users.id` and is load-bearing for authorisation:
    // it is the only thing confining one applicant's ledger from another's.
    // This service writes `Payment` rows directly rather than through
    // `PaymentsService.create`, so without resolving here it would keep
    // storing whatever id the caller happened to hold — which for the only UI
    // that calls it is the CRM `universal_entities.id`, an id no client's
    // `req.user.id` can ever equal. The charge then renders as an honest
    // "nothing recorded" in the client portal, which is the §5.2 failure mode
    // reached by omission.
    private readonly payments: PaymentsService,
  ) {}

  /**
   * What the vertical says things cost and how they may be paid.
   *
   * The expander existed and was reachable from no route, so the instalment
   * options a pack declares could not be offered to anyone — the frontend had to
   * treat EMI signup payments as missing. This is the read half.
   */
  async catalogue(vertical: string | null): Promise<{
    fees: FeeDefinition[];
    plans: PaymentPlanDefinition[];
  }> {
    const [fees, plans] = await Promise.all([
      this.packs.list<FeeDefinition>(vertical, 'fees'),
      this.packs.list<PaymentPlanDefinition>(vertical, 'paymentPlans'),
    ]);
    // Empty arrays are legitimate — a vertical need not publish a fee schedule —
    // and are not an error to distinguish from "the pack is missing".
    return { fees, plans };
  }

  /**
   * Expand fees into `payments` rows.
   *
   * Idempotent per (entity, fee, plan): re-running for the same case returns
   * what already exists instead of charging the client twice. A retry after a
   * partial failure is the normal way this gets called a second time, and
   * double-charging a client is not a recoverable class of bug.
   */
  async expand(request: ExpandRequest): Promise<Payment[]> {
    const fees = await this.feesFor(request.vertical, request.feeKeys);
    const plan = request.planKey
      ? await this.planFor(request.vertical, request.planKey)
      : null;

    const existing = await this.paymentRepo.find({
      where: {
        tenantId: request.tenantId,
        entityId: request.entityId,
        feeKey: In(request.feeKeys),
      },
    });
    if (existing.length) {
      this.logger.log(
        `Fee expansion for entity ${request.entityId} skipped: ` +
          `${existing.length} rows already exist for these fees.`,
      );
      return existing;
    }

    const currencies = new Set(fees.map((f) => f.currency.toUpperCase()));
    if (currencies.size > 1) {
      // A plan splits a *total*, and there is no total across currencies
      // without an exchange rate this system has no business inventing.
      throw new BadRequestException(
        `Cannot expand fees in mixed currencies (${[...currencies].join(', ')}) ` +
          `under one payment plan.`,
      );
    }

    const rows: Payment[] = [];
    const start = request.startDate ?? new Date();

    // Resolved once for the whole expansion rather than per row: every row in
    // a schedule bills the same client, and the resolver refuses (400) when a
    // person record has no invited user yet, so failing before any row is
    // built keeps a schedule all-or-nothing.
    const clientUserId = request.clientId
      ? await this.payments.resolveClientUserId(
          request.tenantId,
          request.clientId,
        )
      : request.clientId;

    for (const fee of fees) {
      const amount = this.amountFor(fee, request);
      if (amount <= 0) continue;

      for (const portion of this.split(fee, amount, plan, start)) {
        rows.push(
          this.paymentRepo.create({
            tenantId: request.tenantId,
            clientId: clientUserId,
            entityId: request.entityId,
            amountMinor: String(portion.amountMinor),
            currency: fee.currency.toUpperCase(),
            status: PaymentStatus.PENDING,
            description: portion.label,
            reference: request.reference ?? null,
            dueDate: portion.dueDate,
            feeKind: fee.kind ?? 'firm',
            feeKey: fee.key,
            planKey: plan?.key ?? null,
            atStep: portion.atStep,
            metadata: {
              // Kept because a government fee has to be defensible: someone
              // will eventually ask which instrument sets this amount.
              ...(fee.reference ? { feeReference: fee.reference } : {}),
              refundable: fee.refundable ?? false,
            },
          }),
        );
      }
    }

    return this.paymentRepo.save(rows);
  }

  private amountFor(fee: FeeDefinition, request: ExpandRequest): number {
    switch (fee.basis ?? 'per_case') {
      case 'per_applicant':
        return fee.amountMinor * Math.max(1, request.applicants ?? 1);
      case 'per_dependent':
        return fee.amountMinor * Math.max(0, request.dependents ?? 0);
      default:
        return fee.amountMinor;
    }
  }

  /**
   * Split one fee into the portions a plan asks for.
   *
   * The remainder handling is the whole reason this is not a one-liner. Money
   * split N ways rarely divides evenly, and the two wrong answers are rounding
   * each portion (the portions no longer sum to the fee) and truncating (the
   * firm quietly under-bills). The remainder goes on the **first** portion, so
   * the shortfall is collected earliest and every later instalment is a round
   * number the client can reconcile.
   */
  private split(
    fee: FeeDefinition,
    amount: number,
    plan: PaymentPlanDefinition | null,
    start: Date,
  ): Array<{
    amountMinor: number;
    label: string;
    dueDate: Date | null;
    atStep: string | null;
  }> {
    const single = [
      {
        amountMinor: amount,
        label: fee.label,
        dueDate: null as Date | null,
        atStep: fee.atStep ?? null,
      },
    ];

    if (!plan || (plan.type ?? 'upfront') === 'upfront') return single;

    if (plan.type === 'installments') {
      const count = Math.max(1, plan.installmentCount ?? 1);
      if (count === 1) return single;

      const base = Math.floor(amount / count);
      const remainder = amount - base * count;
      const intervalDays = plan.intervalDays ?? 30;

      return Array.from({ length: count }, (_, i) => ({
        amountMinor: i === 0 ? base + remainder : base,
        label: `${fee.label} — instalment ${i + 1} of ${count}`,
        dueDate: new Date(start.getTime() + i * intervalDays * 86_400_000),
        atStep: fee.atStep ?? null,
      }));
    }

    // stage_gated
    const stages = plan.stages ?? [];
    if (!stages.length) return single;

    const totalBps = stages.reduce((sum, s) => sum + s.portionBps, 0);
    if (totalBps !== 10_000) {
      // Refuse rather than silently bill a fraction of the fee. Portions that
      // do not sum to 100% mean the client is either under- or over-charged,
      // and neither is something to discover from a ledger months later.
      throw new BadRequestException(
        `Payment plan '${plan.key}' stages sum to ${totalBps} basis points, not 10000.`,
      );
    }

    let allocated = 0;
    return stages.map((stage, i) => {
      const isLast = i === stages.length - 1;
      // The last stage takes whatever is left, so the portions always sum to
      // the fee exactly regardless of how the basis points divide.
      const portion = isLast
        ? amount - allocated
        : Math.floor((amount * stage.portionBps) / 10_000);
      allocated += portion;

      return {
        amountMinor: portion,
        label: stage.label
          ? `${fee.label} — ${stage.label}`
          : `${fee.label} — at ${stage.atStep}`,
        dueDate: null,
        atStep: stage.atStep,
      };
    });
  }

  /**
   * Unsettled portions that block progress past a workflow step.
   *
   * Returns empty unless a plan actually asks for the gate — a firm that has
   * not opted into freezing cases on non-payment must not have its workflows
   * blocked because someone authored a fee schedule.
   */
  async arrearsBlocking(
    tenantId: string,
    vertical: string | null,
    entityId: string,
    stepKey: string,
  ): Promise<Payment[]> {
    const plans =
      (await this.packs.section<PaymentPlanDefinition[]>(
        vertical,
        'paymentPlans',
      )) ?? [];

    const gating = new Set(
      plans.filter((p) => p.blockProgressOnArrears).map((p) => p.key),
    );
    if (!gating.size) return [];

    const unpaid = await this.paymentRepo.find({
      where: {
        tenantId,
        entityId,
        atStep: stepKey,
        status: In([PaymentStatus.PENDING, PaymentStatus.FAILED]),
      },
    });

    return unpaid.filter((p) => p.planKey && gating.has(p.planKey));
  }

  private async feesFor(
    vertical: string | null,
    keys: string[],
  ): Promise<FeeDefinition[]> {
    const all =
      (await this.packs.section<FeeDefinition[]>(vertical, 'fees')) ?? [];
    const byKey = new Map(all.map((f) => [f.key, f]));

    const missing = keys.filter((k) => !byKey.has(k));
    if (missing.length) {
      // Naming the vertical matters: "fee not found" sends whoever hit it
      // looking for a bug in the caller rather than for an un-authored pack.
      throw new BadRequestException(
        `Fees not defined in the ${vertical ?? 'unknown'} pack: ${missing.join(', ')}`,
      );
    }

    return keys.map((k) => byKey.get(k)!);
  }

  private async planFor(
    vertical: string | null,
    key: string,
  ): Promise<PaymentPlanDefinition> {
    const all =
      (await this.packs.section<PaymentPlanDefinition[]>(
        vertical,
        'paymentPlans',
      )) ?? [];
    const plan = all.find((p) => p.key === key);

    if (!plan) {
      throw new BadRequestException(
        `Payment plan '${key}' is not defined in the ${vertical ?? 'unknown'} pack`,
      );
    }

    return plan;
  }
}
