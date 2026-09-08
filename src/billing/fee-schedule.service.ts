import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { TenantFeeOverride } from './entities/tenant-fee-override.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { PaymentsService } from './payments.service';
import { AuditService } from '../audit/audit.service';
import {
  AuditAction,
  AuditSeverity,
} from '../audit/entities/audit-log.entity';

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
 *
 * ADR 0009 §2.4 is the one deliberate exception to "the pack is the only
 * source of an amount": a `kind: 'firm'` fee is a firm's own commercial
 * price, not vertical vocabulary, and `tenant_fee_overrides` lets one tenant
 * replace it without touching the pack every other tenant of the vertical
 * shares. `government` and `disbursement` amounts, and all of `paymentPlans[]`,
 * stay pack-owned — see `setOverrides` for the guard that enforces that.
 */
@Injectable()
export class FeeScheduleService {
  private readonly logger = new Logger(FeeScheduleService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(TenantFeeOverride)
    private readonly overrideRepo: Repository<TenantFeeOverride>,
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
    private readonly audit: AuditService,
  ) {}

  /**
   * What the vertical says things cost and how they may be paid — with any
   * tenant fee override substituted in, so a firm's own portal quotes what it
   * actually charges rather than the pack's shared default. Read side of the
   * ADR 0009 §2.4 merge; `expand`/`feesFor` is the write side, and the two
   * must agree or a firm sees its old rate quoted back after changing it.
   */
  async catalogue(
    vertical: string | null,
    tenantId: string,
  ): Promise<{
    fees: FeeDefinition[];
    plans: PaymentPlanDefinition[];
  }> {
    const [fees, plans] = await Promise.all([
      this.packs.list<FeeDefinition>(vertical, 'fees'),
      this.packs.list<PaymentPlanDefinition>(vertical, 'paymentPlans'),
    ]);
    // Empty arrays are legitimate — a vertical need not publish a fee schedule —
    // and are not an error to distinguish from "the pack is missing".
    return { fees: await this.withOverrides(tenantId, fees), plans };
  }

  /**
   * Substitutes an active tenant override's `amountMinor`/`currency` into
   * every `kind: 'firm'` fee it names, leaving everything structural — label,
   * kind, basis, atStep, refundable — exactly as the pack declares it. Only
   * `firm` fees are even looked up: `government`/`disbursement` amounts have
   * no override row to find, by construction of `setOverrides`' guard, so
   * this is belt-and-braces rather than the only thing stopping it.
   */
  private async withOverrides(
    tenantId: string,
    fees: FeeDefinition[],
  ): Promise<FeeDefinition[]> {
    const firmKeys = fees
      .filter((f) => f.kind === 'firm')
      .map((f) => f.key);
    if (!firmKeys.length) return fees;

    const overrides = await this.overrideRepo.find({
      where: { tenantId, feeKey: In(firmKeys), active: true },
    });
    if (!overrides.length) return fees;

    const byKey = new Map(overrides.map((o) => [o.feeKey, o]));
    return fees.map((f) => {
      const override = f.kind === 'firm' ? byKey.get(f.key) : undefined;
      return override
        ? {
            ...f,
            amountMinor: Number(override.amountMinor),
            currency: override.currency,
          }
        : f;
    });
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
    const fees = await this.feesFor(
      request.tenantId,
      request.vertical,
      request.feeKeys,
    );
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
    tenantId: string,
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

    return this.withOverrides(
      tenantId,
      keys.map((k) => byKey.get(k)!),
    );
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

  /**
   * ADR 0009 §2.4 — replace this tenant's active firm-fee overrides with
   * exactly the set given.
   *
   * **Complete desired state, not a delta** — same reasoning
   * `OperatorUpdateEntitlementsDto.modules` already uses for entitlements: a
   * caller reverting one fee to the pack default has to be able to simply omit
   * it, and a PATCH-style merge cannot express "remove this."
   *
   * **Validated against the resolved pack, not the DTO**, because the DTO
   * cannot see the pack: every `feeKey` must both exist there and be
   * `kind: 'firm'`. This is the one guard standing between a firm and quietly
   * overriding `gov_482_primary` — a government charge is not the firm's to
   * set, and misstating it would be the "sandbox result presented as live"
   * failure shape applied to money. Checked for the whole batch before any
   * row is written, the same all-or-nothing posture `expand`'s mixed-currency
   * check already uses.
   */
  async setOverrides(
    tenantId: string,
    vertical: string | null,
    overrides: Array<{ feeKey: string; amountMinor: number; currency: string }>,
    updatedBy: string,
  ): Promise<TenantFeeOverride[]> {
    const packFees =
      (await this.packs.section<FeeDefinition[]>(vertical, 'fees')) ?? [];
    const byKey = new Map(packFees.map((f) => [f.key, f]));

    for (const o of overrides) {
      const def = byKey.get(o.feeKey);
      if (!def) {
        throw new BadRequestException(
          `Fee '${o.feeKey}' is not defined in the ${vertical ?? 'unknown'} pack`,
        );
      }
      if (def.kind !== 'firm') {
        throw new BadRequestException(
          `Fee '${o.feeKey}' is a '${def.kind ?? 'undeclared-kind'}' fee — only ` +
            `a firm's own 'firm' fees may be overridden. Government and ` +
            `disbursement amounts are set by the pack.`,
        );
      }
    }

    const existing = await this.overrideRepo.find({ where: { tenantId } });
    const existingByKey = new Map(existing.map((e) => [e.feeKey, e]));
    const desiredKeys = new Set(overrides.map((o) => o.feeKey));

    // Anything not named in this call's complete desired state reverts to
    // the pack default.
    for (const row of existing) {
      if (desiredKeys.has(row.feeKey)) continue;
      await this.overrideRepo.remove(row);
      await this.audit.logEvent({
        tenantId,
        userId: updatedBy,
        action: AuditAction.DELETE,
        entityType: 'tenant_fee_override',
        entityId: row.id,
        severity: AuditSeverity.INFO,
        description: `Fee override for '${row.feeKey}' removed — reverting to the pack default.`,
        context: {
          feeKey: row.feeKey,
          amountMinor: null,
          currency: null,
          previousAmountMinor: Number(row.amountMinor),
        },
      });
    }

    const saved: TenantFeeOverride[] = [];
    for (const o of overrides) {
      const prior = existingByKey.get(o.feeKey);
      const previousAmountMinor = prior ? Number(prior.amountMinor) : null;
      const row =
        prior ?? this.overrideRepo.create({ tenantId, feeKey: o.feeKey });
      row.amountMinor = String(o.amountMinor);
      row.currency = o.currency.toUpperCase();
      row.active = true;
      row.updatedBy = updatedBy;

      const stored = await this.overrideRepo.save(row);
      saved.push(stored);

      await this.audit.logEvent({
        tenantId,
        userId: updatedBy,
        action: prior ? AuditAction.UPDATE : AuditAction.CREATE,
        entityType: 'tenant_fee_override',
        entityId: stored.id,
        severity: AuditSeverity.INFO,
        description: `Fee override set for '${o.feeKey}': ${o.amountMinor} ${row.currency}.`,
        context: {
          feeKey: o.feeKey,
          amountMinor: o.amountMinor,
          currency: row.currency,
          previousAmountMinor,
        },
      });
    }

    return saved;
  }
}
