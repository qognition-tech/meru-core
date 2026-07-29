import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityStatus,
  EntityType,
  UniversalEntity,
} from '../../crm/entities/universal-entity.entity';
import { ScreeningEngine } from '../../ai/engines/screening.engine';

export interface TradeInstrumentDto {
  type?: string;
  applicant?: string;
  beneficiary?: string;
  amount?: number;
  currency?: string;
  status?: string;
  issuedDate?: string;
  expiryDate?: string;
  country?: string;
  vesselImo?: string;
}

/**
 * Trade finance instruments — letters of credit, guarantees, collections.
 *
 * Backed by `UniversalEntity`, not a `trade_transactions` table. Trade finance
 * is a GovernanceX (banking) concern, and CLAUDE.md §11.3 keeps vertical
 * schemas out of core: the instrument is a record with parties, an amount and
 * a lifecycle, which the polymorphic entity already models. The banking-shaped
 * fields live in `verticalAttributes`, exactly as obligations and breaches do.
 *
 * What core *does* contribute is the part that is genuinely horizontal:
 * counterparty screening through the Screening engine (§3.2), which every
 * vertical shares.
 */
@Injectable()
export class TradeService {
  private readonly logger = new Logger(TradeService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    private readonly screening: ScreeningEngine,
  ) {}

  private toTransaction(row: UniversalEntity) {
    const a = row.verticalAttributes ?? {};
    return {
      id: row.id,
      type: a.instrumentType ?? 'LC',
      reference: row.firstName ?? null,
      applicant: a.applicant ?? null,
      beneficiary: a.beneficiary ?? null,
      amount: a.amount ?? 0,
      currency: a.currency ?? 'USD',
      status: row.status ?? EntityStatus.OPEN,
      screeningStatus: a.screeningStatus ?? 'PENDING',
      screeningHits: a.screeningHits ?? 0,
      issuedDate: a.issuedDate ?? null,
      expiryDate: row.dueDate ?? a.expiryDate ?? null,
      country: a.country ?? null,
      vesselImo: a.vesselImo ?? null,
      assignedTo: row.assignedTo,
      createdAt: row.createdAt,
    };
  }

  private async rows(tenantId: string): Promise<UniversalEntity[]> {
    return this.entityRepo.find({
      where: { tenantId, type: EntityType.TRADE_INSTRUMENT },
      order: { createdAt: 'DESC' },
    });
  }

  async list(tenantId: string) {
    const rows = await this.rows(tenantId);
    return rows.map((r) => this.toTransaction(r));
  }

  async get(tenantId: string, id: string) {
    const row = await this.entityRepo.findOne({
      where: { id, tenantId, type: EntityType.TRADE_INSTRUMENT },
    });
    if (!row) throw new NotFoundException('Trade instrument not found');
    return this.toTransaction(row);
  }

  /**
   * Create an instrument and screen its counterparties in the same call.
   *
   * Screening happens on write rather than on a later sweep because an
   * unscreened instrument is the thing a bank must not book. A screening
   * failure does not block the write — the record is kept with
   * `screeningStatus: 'ERROR'` so it surfaces for manual review, rather than
   * the instrument silently not existing.
   */
  async create(tenantId: string, dto: TradeInstrumentDto) {
    const screening = await this.screenParties(tenantId, dto);

    const row = await this.entityRepo.save(
      this.entityRepo.create({
        tenantId,
        type: EntityType.TRADE_INSTRUMENT,
        firstName: `${dto.type ?? 'LC'}-${Date.now().toString(36).toUpperCase()}`,
        status: EntityStatus.OPEN,
        dueDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        verticalAttributes: {
          instrumentType: dto.type ?? 'LC',
          applicant: dto.applicant,
          beneficiary: dto.beneficiary,
          amount: dto.amount,
          currency: dto.currency ?? 'USD',
          issuedDate: dto.issuedDate,
          expiryDate: dto.expiryDate,
          country: dto.country,
          vesselImo: dto.vesselImo,
          ...screening,
        },
      }),
    );

    return this.toTransaction(row);
  }

  async update(tenantId: string, id: string, dto: TradeInstrumentDto) {
    const row = await this.entityRepo.findOne({
      where: { id, tenantId, type: EntityType.TRADE_INSTRUMENT },
    });
    if (!row) throw new NotFoundException('Trade instrument not found');

    if (dto.status) row.status = dto.status as EntityStatus;
    if (dto.expiryDate) row.dueDate = new Date(dto.expiryDate);

    // Merge, never replace — the same rule as PATCH /crm/entities/:id. A status
    // change must not wipe the screening result stored alongside it.
    row.verticalAttributes = {
      ...(row.verticalAttributes ?? {}),
      ...(dto.type !== undefined ? { instrumentType: dto.type } : {}),
      ...(dto.applicant !== undefined ? { applicant: dto.applicant } : {}),
      ...(dto.beneficiary !== undefined
        ? { beneficiary: dto.beneficiary }
        : {}),
      ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.country !== undefined ? { country: dto.country } : {}),
      ...(dto.vesselImo !== undefined ? { vesselImo: dto.vesselImo } : {}),
    };

    // Re-screen when a counterparty changed. Carrying forward a clear result
    // from a different name would be worse than not screening at all.
    if (dto.applicant !== undefined || dto.beneficiary !== undefined) {
      const rescreen = await this.screenParties(tenantId, {
        applicant: row.verticalAttributes.applicant,
        beneficiary: row.verticalAttributes.beneficiary,
      });
      row.verticalAttributes = { ...row.verticalAttributes, ...rescreen };
    }

    await this.entityRepo.save(row);
    return this.toTransaction(row);
  }

  /**
   * Run both counterparties through the Screening engine.
   *
   * Typed against `ScreeningRequest` with no cast. An earlier draft passed
   * `{ fullName }` behind an `as any`, which the engine would have read as an
   * undefined `entityName` — screening nothing and returning a confident
   * CLEAR. That is the same silent-wrong-answer failure the `/integrations/
   * ae/screening` DTO exists to prevent, and a cast would have re-introduced it.
   */
  private async screenParties(tenantId: string, dto: TradeInstrumentDto) {
    const parties = [dto.applicant, dto.beneficiary].filter(
      (n): n is string => !!n && n.trim().length > 1,
    );

    if (parties.length === 0) {
      return { screeningStatus: 'NOT_APPLICABLE', screeningHits: 0 };
    }

    try {
      const results = await Promise.all(
        parties.map((name) =>
          this.screening.screen({
            tenantId,
            entityName: name,
            entityType: 'organization',
            screeningTypes: ['sanctions', 'pep'],
          }),
        ),
      );

      const hits = results.reduce((sum, r) => sum + (r?.hits?.length ?? 0), 0);

      return {
        screeningStatus: hits > 0 ? 'HIT' : 'CLEAR',
        screeningHits: hits,
        screenedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Counterparty screening failed: ${message}`);
      return {
        screeningStatus: 'ERROR',
        screeningHits: 0,
        screeningError: message,
      };
    }
  }
}
