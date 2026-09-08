import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { UniversalEntity } from './entities/universal-entity.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditSeverity } from '../audit/entities/audit-log.entity';
import { CrmAccessService } from './crm-access.service';
import { Actor } from '../common/access';

export interface AcceptanceRecord {
  /** What was accepted — a document template key, or a named term. */
  subject: string;
  /** Who accepted, as the platform knows them. */
  userId: string;
  email: string;
  acceptedAt: string;
  /** Where from. Weak evidence on its own, but it is what a browser can offer. */
  ip: string | null;
  userAgent: string | null;
  /**
   * SHA-256 of the exact bytes the person was shown, when the caller supplies
   * them. Without this an acceptance records that somebody clicked something,
   * not *what* they agreed to — and the wording can change afterwards with
   * nothing to detect it.
   */
  documentSha256: string | null;
  /**
   * Always false, and deliberately part of the payload.
   *
   * This is a record of assent, not a signature. It has no signatory
   * certificate, no tamper-evident envelope and no independent timestamp
   * authority, so it is not an electronically signed instrument under the
   * Australian ETA or its equivalents. A UI must say so where it collects it —
   * for an immigration engagement letter, "the client ticked a box" and "the
   * client signed" are not the same thing, and only one of them is enforceable
   * the way a firm will assume.
   */
  isSignature: false;
}

/**
 * Recording that someone accepted something, honestly.
 *
 * The frontend asked for e-signature and explicitly declined to build an
 * approximation, which was the right call — an approximation of a signature is
 * worse than none, because everyone downstream treats it as one. This is the
 * narrower thing that is actually true: an audited, hash-anchored record of
 * assent, labelled as not being a signature.
 *
 * Real e-signature means a provider (DocuSign, Adobe) or a certificate
 * authority. That is a commercial decision, not an afternoon's code, and it
 * belongs on the same list as the regulator licences.
 */
@Injectable()
export class AcceptanceService {
  private readonly logger = new Logger(AcceptanceService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entities: Repository<UniversalEntity>,
    private readonly audit: AuditService,
    private readonly access: CrmAccessService,
  ) {}

  /**
   * Record an acceptance against a record.
   *
   * Appended to `verticalAttributes.acceptances[]` rather than replacing, so a
   * client who accepts revised terms does not erase the version they agreed to
   * first — the earlier acceptance is the one that governs what happened before
   * the change.
   *
   * `actor` is required and checked for **read**, not write. Recording
   * acceptance is a client-facing action they legitimately perform on their
   * own record — an applicant accepting a cost agreement — so it must keep
   * working for `own` scope; `CrmAccessService` only refuses `own` scope on
   * the generic write path (`PATCH /crm/entities/:id`), which this is not.
   */
  async record(
    tenantId: string,
    entityId: string,
    input: {
      subject: string;
      userId: string;
      email: string;
      ip?: string | null;
      userAgent?: string | null;
      /** The exact document bytes shown, to be hashed. */
      documentBytes?: Buffer | null;
      /** A hash the caller computed itself, if it has the bytes and we do not. */
      documentSha256?: string | null;
    },
    actor: Actor,
  ): Promise<AcceptanceRecord> {
    const entity = await this.entities.findOne({
      where: { id: entityId, tenantId },
    });
    if (!entity) throw new NotFoundException('Entity not found');
    this.access.assert(entity, actor, 'read');

    if (!input.subject?.trim()) {
      throw new BadRequestException(
        'subject is required — an acceptance of nothing in particular records nothing',
      );
    }

    const sha =
      input.documentSha256 ??
      (input.documentBytes
        ? crypto.createHash('sha256').update(input.documentBytes).digest('hex')
        : null);

    const record: AcceptanceRecord = {
      subject: input.subject.trim(),
      userId: input.userId,
      email: input.email,
      acceptedAt: new Date().toISOString(),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      documentSha256: sha,
      isSignature: false,
    };

    const existing = Array.isArray(entity.verticalAttributes?.acceptances)
      ? (entity.verticalAttributes!.acceptances as AcceptanceRecord[])
      : [];

    entity.verticalAttributes = {
      ...(entity.verticalAttributes ?? {}),
      acceptances: [...existing, record],
    };

    await this.entities.save(entity);

    // The audit chain is the part that makes this worth anything. A row in a
    // jsonb column can be edited by anyone with write access; the hash-chained
    // audit entry cannot be altered without breaking the chain, so the two
    // together are evidence rather than an assertion.
    await this.audit.logEvent({
      tenantId,
      userId: input.userId,
      userEmail: input.email,
      action: AuditAction.UPDATE,
      entityType: 'entity_acceptance',
      entityId,
      severity: AuditSeverity.WARNING,
      description:
        `Acceptance recorded for '${record.subject}' by ${input.email}` +
        (sha
          ? ` (document sha256 ${sha.slice(0, 16)}…)`
          : ' (no document hash supplied)'),
      afterState: { ...record },
      context: { ip: record.ip, userAgent: record.userAgent },
    });

    this.logger.log(
      `Acceptance recorded: entity ${entityId}, subject '${record.subject}'`,
    );
    return record;
  }

  /** Every acceptance on a record, oldest first. */
  async list(
    tenantId: string,
    entityId: string,
    actor: Actor,
  ): Promise<AcceptanceRecord[]> {
    const entity = await this.entities.findOne({
      where: { id: entityId, tenantId },
    });
    if (!entity) throw new NotFoundException('Entity not found');
    this.access.assert(entity, actor, 'read');

    const raw = entity.verticalAttributes?.acceptances;
    return Array.isArray(raw) ? (raw as AcceptanceRecord[]) : [];
  }
}
