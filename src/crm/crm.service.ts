import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UniversalEntity,
  EntityStatus,
  EntityType,
} from './entities/universal-entity.entity';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { SearchService } from '../search/search.service';
import { CreateEntityInput } from '../common/types';
import { DocumentHubService } from '../documents/document-hub.service';
import { deepMerge } from '../common/deep-merge';
import { toCsv } from '../common/csv';
import { Document } from '../documents/entities/document.entity';
import { EntityRelationService } from './entity-relation.service';
import { CrmAccessService } from './crm-access.service';
import { Actor } from '../common/access';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';

/**
 * Statuses that mean the record is finished. Transitioning *into* one of these
 * is what the dependency gate checks; everything else is an ordinary edit.
 */
const COMPLETION_STATUSES: EntityStatus[] = [
  EntityStatus.RESOLVED,
  EntityStatus.CLOSED,
  EntityStatus.CANCELLED,
];

/**
 * Types that represent work someone has to finish, and therefore have a
 * lifecycle. Everything else (tag, note, plain person/organization) is
 * reference data and leaves `status` null.
 */
const WORKABLE_TYPES: ReadonlySet<EntityType> = new Set([
  EntityType.CASE,
  EntityType.OBLIGATION,
  EntityType.BREACH,
  EntityType.LEAD,
  // GovX module areas whose records are worked to a conclusion. Reference
  // data (knowledge articles, training modules) is deliberately NOT here —
  // an article has no assignee or due date.
  EntityType.VENDOR,
  EntityType.CONTROL_TEST,
  EntityType.RISK_SCENARIO,
  EntityType.MILESTONE,
  EntityType.RFI,
  EntityType.SCREENING_MATCH,
  EntityType.SAR,
]);

function defaultStatusFor(type: EntityType): EntityStatus | null {
  return WORKABLE_TYPES.has(type) ? EntityStatus.OPEN : null;
}

/**
 * Which type may become which, for `POST /crm/entities/:id/convert`.
 *
 * An allowlist rather than "anything to anything": a case is not a person, and
 * a conversion that makes no sense is a data-modelling accident that the id
 * keeps alive forever. Kept in core because these are structural relationships
 * between generic types — a lead is a prospective subject in every vertical —
 * and carries no vertical vocabulary (CLAUDE.md §5.5).
 */
const CONVERTIBLE_TYPES: ReadonlyMap<
  EntityType,
  ReadonlySet<EntityType>
> = new Map([
  // The one the immigration lifecycle needs: a qualified lead becomes the
  // client, or the organisation that engaged the firm.
  [EntityType.LEAD, new Set([EntityType.PERSON, EntityType.ORGANIZATION])],
  // Sole trader incorporates, or a company record turns out to be a person.
  [EntityType.PERSON, new Set([EntityType.ORGANIZATION])],
  [EntityType.ORGANIZATION, new Set([EntityType.PERSON])],
]);

/**
 * The types a vertical's configured field list actually describes — the
 * "Client"/"Applicant"/"Patient" that `VerticalConfig.entityName` names.
 * Structural records (note, tag) and workable ones (case, obligation, breach)
 * carry their own attributes and are not held to the subject's schema.
 */
const SUBJECT_TYPES: ReadonlySet<EntityType> = new Set([
  EntityType.PERSON,
  EntityType.ORGANIZATION,
]);

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private entityRepo: Repository<UniversalEntity>,
    private tenantSettingsService: TenantSettingsService,
    private searchService: SearchService,
    private documentHubService: DocumentHubService,
    private relations: EntityRelationService,
    private readonly access: CrmAccessService,
    private readonly packs: VerticalPackService,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  /**
   * Refuse a change to a field the pack has declared immutable.
   *
   * The only genuine server-side field lock in the platform. A settlement mode
   * that stays editable after lodgement is not a record of what was agreed, it
   * is a record of what somebody last typed — and that distinction is what a
   * fee dispute turns on.
   *
   * Three things keep this from becoming cross-vertical breakage (§7.2):
   *
   * - It is opt-in per field. A pack with no `lockedWhen` anywhere — which is
   *   every GRC pack — reaches the `return` on the first line and nothing
   *   changes.
   * - It only ever refuses a change to the ONE field whose condition holds.
   *   It never blocks an unrelated edit on the same PATCH.
   * - A condition that does not compile is logged and IGNORED, not treated as
   *   locked. A malformed pack must not be able to freeze a tenant's records;
   *   the failure direction is "not enforced and said so", never "everything
   *   is read-only and nobody knows why".
   *
   * Evaluated against the same flattened view rules see: `verticalAttributes`
   * promoted one level, top-level columns winning.
   */
  private async assertNoLockedFieldChanged(
    entity: UniversalEntity,
    updates: { verticalAttributes?: Record<string, unknown> },
    vertical: string | null,
  ): Promise<void> {
    const incoming = updates.verticalAttributes;
    if (!incoming || Object.keys(incoming).length === 0) return;

    const entityTypes = await this.packs.section<
      Array<{
        type: string;
        fields?: Array<{ key: string; label?: string; lockedWhen?: unknown }>;
      }>
    >(vertical, 'entityTypes');
    if (!entityTypes?.length) return;

    const forType = entityTypes.find((e) => e.type === entity.type);
    const locked = (forType?.fields ?? []).filter((f) => f.lockedWhen != null);
    if (!locked.length) return;

    const attrs =
      (entity.verticalAttributes as Record<string, unknown> | undefined) ?? {};
    const data: Record<string, unknown> = { ...attrs, ...entity };

    for (const field of locked) {
      // Only a field this PATCH actually mentions can be refused. `undefined`
      // means "not sent", which is not a change.
      if (!(field.key in incoming)) continue;

      const next = incoming[field.key];
      const current = attrs[field.key];
      if (next === current) continue;

      const check = this.evaluator.validate(field.lockedWhen);
      if (!check.valid) {
        this.logger.error(
          `Pack field lock '${entity.type}.${field.key}' does not compile and ` +
            `is NOT being enforced: ${check.reason}`,
        );
        continue;
      }

      if (this.evaluator.matches(field.lockedWhen, data)) {
        throw new ConflictException(
          `${field.label ?? field.key} cannot be changed on this record any ` +
            `more. The pack locks it at this stage, and the value on file is ` +
            `what the parties agreed to.`,
        );
      }
    }
  }

  async createEntity(
    tenantId: string,
    dto: CreateEntityInput,
  ): Promise<UniversalEntity> {
    this.logger.log(`Creating entity for tenant: ${tenantId}`, {
      entityType: dto.type,
    });

    try {
      const settings = await this.tenantSettingsService.getSettings(tenantId);

      // `fields` is the vertical's required-attribute list, supplied by a config
      // pack. A tenant provisioned through signup starts with only
      // `{ limits, features }`, so this was `undefined` and every create failed
      // with "settings.fields is not iterable". No configured fields simply
      // means there is nothing extra to require.
      //
      // The list describes the vertical's *subject* record — `VerticalConfig`
      // names it in the singular (`entityName`: "Client", "Applicant",
      // "Patient"). It was applied to every polymorphic type, so creating a
      // tag, a note or an obligation also demanded the subject's fields:
      // "Missing required vertical attribute: Tax ID" when filing a compliance
      // obligation. Only subject records are held to it.
      if (SUBJECT_TYPES.has(dto.type)) {
        for (const field of settings?.fields ?? []) {
          if (field.required && !dto.verticalAttributes?.[field.key]) {
            throw new BadRequestException(
              `Missing required vertical attribute: ${field.label} (${field.key})`,
            );
          }
        }
      }

      if (dto.email) {
        const existing = await this.entityRepo.findOne({
          where: { tenantId, email: dto.email },
        });
        if (existing) {
          throw new BadRequestException(
            'Entity with this email already exists.',
          );
        }
      }

      const entity = this.entityRepo.create({
        tenantId,
        type: dto.type,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        // Normalised on write so the client-portal filter is a plain indexed
        // comparison and not a per-row function. A record saved without this
        // is invisible to the person it is about — see the column's own
        // comment on `UniversalEntity`.
        //
        // A PERSON is its own subject, so that one is derived here rather than
        // left to every caller to remember. The equivalent for a case — the
        // applicant's address — cannot be derived in core: where it lives is
        // vertical vocabulary (§5.5), so the vertical's client sends it, and
        // the backfill migration handles records that predate it.
        subjectEmail:
          dto.subjectEmail?.trim().toLowerCase() ||
          (dto.type === EntityType.PERSON
            ? dto.email?.trim().toLowerCase() || null
            : null),
        phoneNumber: dto.phoneNumber,
        verticalAttributes: dto.verticalAttributes,
        // Workable types (case, obligation, breach) start OPEN unless the
        // caller says otherwise; reference types (tag, note, person) stay null
        // so "status" never means something for a row that has no lifecycle.
        status: dto.status ?? defaultStatusFor(dto.type),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        assignedTo: dto.assignedTo ?? null,
      });

      const savedEntity = await this.entityRepo.save(entity);

      this.logger.log(`Entity created successfully: ${savedEntity.id}`);

      this.searchService.indexEntityData(savedEntity).catch((err) => {
        this.logger.error('Failed to index entity:', err);
      });

      return savedEntity;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to create entity: ${message}`, stack);
      throw new BadRequestException(`Failed to create entity: ${message}`);
    }
  }

  async addRelationship(
    parentId: string,
    childId: string,
    relationType: string,
  ): Promise<UniversalEntity> {
    this.logger.log(
      `Adding relationship: ${parentId} -> ${childId} (${relationType})`,
    );

    const parent = await this.entityRepo.findOne({ where: { id: parentId } });
    const child = await this.entityRepo.findOne({ where: { id: childId } });

    if (!parent || !child) {
      throw new BadRequestException('Entity not found');
    }

    const updatedRelationships = [...parent.relationships];
    updatedRelationships.push({ id: childId, type: relationType });

    parent.relationships = updatedRelationships;
    await this.entityRepo.save(parent);

    this.logger.log(`Relationship added successfully`);

    return parent;
  }

  async getEntitiesByTenant(tenantId: string): Promise<UniversalEntity[]> {
    return this.entityRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * The `WHERE`/`ORDER BY` shared by `listEntities` and `exportEntitiesCsv` —
   * everything about "which rows and in what order" except how many. Split
   * out so the export's row cap (10,000) cannot be silently clamped down to
   * the list's page size (200) the way it was: `exportEntitiesCsv` used to
   * call `listEntities({ ...filters, limit: MAX_ROWS })`, and `listEntities`
   * clamps whatever `limit` it is given to 200 before the query ever runs —
   * so a firm exporting 600 matching records got a 200-row file with
   * `X-Export-Truncated` never even firing to say so (`total` was computed
   * against the same 200-row page).
   */
  private buildEntityListQuery(
    tenantId: string,
    filters: {
      type?: EntityType;
      status?: EntityStatus;
      assignedTo?: string;
      subjectEmail?: string;
      dueBefore?: string;
      dueAfter?: string;
    },
  ) {
    const qb = this.entityRepo
      .createQueryBuilder('e')
      .where('e."tenantId" = :tenantId', { tenantId })
      // Soft-deleted rows are not results. `deleteEntity` currently hard
      // -removes, but the column exists and anything that starts using it
      // must not silently resurrect rows here.
      .andWhere('e."deletedAt" IS NULL');

    if (filters.type) qb.andWhere('e.type = :type', { type: filters.type });
    if (filters.status)
      qb.andWhere('e.status = :status', { status: filters.status });
    if (filters.assignedTo)
      qb.andWhere('e."assignedTo" = :assignedTo', {
        assignedTo: filters.assignedTo,
      });
    // Compared lower-cased and trimmed on both sides: the stored value comes
    // from a form and the filter value from a JWT, and "A@x.com" and
    // "a@x.com " are the same applicant. The migration normalises what it
    // backfills for the same reason.
    //
    // Keyed on `!== undefined`, NOT on truthiness, and an unusable value denies
    // everything rather than filtering nothing.
    //
    // `CrmController.clientScoped` always SETS this key for a client-role
    // caller, to `user.email`. Written as `if (filters.subjectEmail)`, an empty
    // or missing JWT email made the whole predicate disappear — and a client
    // then received every record in the tenant instead of none. That is the
    // original leak this column was added to close, reintroduced from the
    // other direction. The sibling checks in `CrmAccessService.ownsEntity`,
    // `DocumentAccessService` and `WorkflowService` all fail closed on the
    // same condition; this one has to as well.
    if (filters.subjectEmail !== undefined) {
      const needle = filters.subjectEmail.trim().toLowerCase();
      if (needle) {
        qb.andWhere('LOWER(TRIM(e."subjectEmail")) = :subjectEmail', {
          subjectEmail: needle,
        });
      } else {
        qb.andWhere('1 = 0');
      }
    }
    if (filters.dueAfter)
      qb.andWhere('e."dueDate" >= :dueAfter', { dueAfter: filters.dueAfter });
    if (filters.dueBefore)
      qb.andWhere('e."dueDate" <= :dueBefore', {
        dueBefore: filters.dueBefore,
      });

    // Nulls last so undated records do not crowd out what is actually due.
    return qb
      .orderBy('e."dueDate"', 'ASC', 'NULLS LAST')
      .addOrderBy('e."createdAt"', 'DESC');
  }

  /**
   * Filtered, paginated entity listing.
   *
   * This is what backs the obligation and breach registers and the case
   * kanban: they are all "records of one type, in some state, owned by
   * someone, due around then". Filtering here rather than in each vertical
   * keeps the 80% shared (CLAUDE.md §4).
   */
  async listEntities(
    tenantId: string,
    filters: {
      type?: EntityType;
      status?: EntityStatus;
      assignedTo?: string;
      subjectEmail?: string;
      dueBefore?: string;
      dueAfter?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{
    items: UniversalEntity[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));

    const [items, total] = await this.buildEntityListQuery(tenantId, filters)
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }

  /**
   * Liveness probe for `GET /orchestration/health`: one cheap statement
   * against the entities table on the pooled connection. Proves the table is
   * reachable through this service's repository, nothing more — it is not a
   * count and does not depend on the caller's tenant having any rows.
   */
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.entityRepo.manager.query(
        'SELECT 1 FROM "universal_entities" LIMIT 1',
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch by id without throwing, for internal callers that handle `null`.
   *
   * **`tenantId` is required, and that requirement is the point of this
   * signature.** It previously took an id alone, which made it the unscoped
   * primitive every by-id leak in this codebase eventually reached for:
   * `AiService`'s cross-module context and three `OrchestrationService`
   * methods all called it while a perfectly good `tenantId` sat unused in the
   * same scope. RLS caught them — but RLS is the last line, not the first, and
   * under `runAsGod` or a future job context it is not a line at all.
   *
   * Prefer {@link getEntity}, which is actor-scoped as well and 404s rather
   * than returning `null`. Reach for this only where a missing row is an
   * ordinary outcome rather than an error.
   */
  async findEntityById(
    id: string,
    tenantId: string,
  ): Promise<UniversalEntity | null> {
    return this.entityRepo.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Tenant-scoped fetch. Unlike `findEntityById`, this cannot return another
   * tenant's row and 404s rather than yielding null, so controllers do not each
   * have to remember the scoping.
   *
   * `actor` is required, not optional — this is the fix for the bug
   * `CrmAccessService` documents: every by-id route used to reach this method
   * with no actor at all, so a `client` token that knew a UUID could read any
   * other applicant's case. An optional actor a caller could forget to pass
   * would have been the same bug with extra steps; the compiler now finds
   * every call site instead.
   */
  async getEntity(
    id: string,
    tenantId: string,
    actor: Actor,
  ): Promise<UniversalEntity> {
    const entity = await this.entityRepo.findOne({ where: { id, tenantId } });
    if (!entity) throw new NotFoundException('Entity not found');
    this.access.assert(entity, actor, 'read');
    return entity;
  }

  /**
   * Currently unreachable from any controller — `grep -rn deleteEntity src`
   * finds no route registered for it, only this definition. Secured anyway,
   * on the same reasoning as `getEntity`: an actor-less method is exactly how
   * this bug shape keeps recurring, and the next person to wire up
   * `DELETE /crm/entities/:id` should not have to remember to add the check.
   */
  async deleteEntity(
    id: string,
    tenantId: string,
    actor: Actor,
  ): Promise<void> {
    const entity = await this.entityRepo.findOne({
      where: { id, tenantId },
    });

    if (!entity) {
      throw new BadRequestException('Entity not found');
    }

    this.access.assert(entity, actor, 'delete');

    await this.entityRepo.remove(entity);
    this.logger.log(`Entity deleted: ${id}`);
  }

  async updateEntity(
    id: string,
    tenantId: string,
    /**
     * Required, not optional — see the note on `getEntity`. `own` scope (a
     * bare client, a bare `platform_admin`) never passes `CrmAccessService`'s
     * write check: a client changes their record through a named route
     * (acceptance, a workflow transition), never this generic PATCH, or they
     * could reassign their own case or mark it lodged.
     */
    actor: Actor,
    updates: Partial<UniversalEntity>,
    /**
     * The caller's vertical, which selects the pack whose `relationships[]`
     * declare what blocks completion. Optional so existing callers keep
     * compiling; without it the pack cannot be consulted and no dependency is
     * enforced — the pre-existing behaviour.
     */
    vertical?: string | null,
  ): Promise<UniversalEntity> {
    const entity = await this.entityRepo.findOne({
      where: { id, tenantId },
    });

    // 404, not 400 — the caller's request was well-formed, the record just is
    // not theirs or does not exist. (Under RLS these are indistinguishable,
    // which is the point: a wrong-tenant id must not be reported differently
    // from a nonexistent one, or the response becomes an existence oracle.)
    if (!entity) {
      throw new NotFoundException('Entity not found');
    }

    // `own` scope reaches here only through `deleteEntity`'s sibling checks
    // never applying — this throws 404 on an unreadable record, 403 on a
    // readable one it may not change. See `CrmAccessService.assert`.
    this.access.assert(entity, actor, 'write');

    // Dependency gate. A relation the pack marks `blocksCompletion` refuses
    // the close while the thing it points at is still open — which is what
    // makes a declared dependency a dependency rather than a note on a record.
    // Checked only on the transition *into* a closed state, so reopening and
    // ordinary edits are never blocked.
    const closing =
      updates.status !== undefined &&
      COMPLETION_STATUSES.includes(updates.status as EntityStatus) &&
      !COMPLETION_STATUSES.includes(entity.status as EntityStatus);

    if (closing) {
      await this.relations.assertCompletable(
        tenantId,
        actor,
        vertical ?? null,
        id,
      );
    }

    // Before anything is applied: a field the pack has frozen at this stage
    // may not move. Checked against the record as it stands, not as it would
    // stand after the merge.
    await this.assertNoLockedFieldChanged(entity, updates, vertical ?? null);

    const { verticalAttributes, ...rest } = updates;
    Object.assign(entity, rest);

    // Normalised on write, matching `createEntity` and the backfill migration,
    // so the client-portal filter stays an indexed comparison. An explicit
    // empty string clears it — which HIDES the record from its subject, so it
    // is only ever what the caller literally sent.
    if (rest.subjectEmail !== undefined) {
      entity.subjectEmail = rest.subjectEmail?.trim().toLowerCase() || null;
    }

    // `verticalAttributes` merges rather than replaces, at every depth.
    //
    // A top-level spread was not enough. Packs nest — the immigration pack keeps
    // a lead's identity under `lead.fields` — so `{ lead: { lead_status: 'x' } }`
    // replaced the whole `lead` object and destroyed `lead.fields.first_name`
    // with it. The frontend hit exactly that during lead conversion and lost a
    // person's name. Documenting a shallow merge was the alternative, but a
    // PATCH that silently deletes data the caller never mentioned is a trap
    // whichever way it is written down.
    if (verticalAttributes) {
      entity.verticalAttributes = deepMerge(
        entity.verticalAttributes ?? {},
        verticalAttributes,
      );
    }

    const updated = await this.entityRepo.save(entity);

    this.logger.log(`Entity updated: ${id}`);

    return updated;
  }

  /**
   * Change a record's `type`, keeping its id and therefore its history.
   *
   * A lead that becomes a client is the same person. `PATCH /crm/entities/:id`
   * refuses `type` — correctly, since a type change is not an ordinary field
   * edit and should not be reachable by a stray key in a form payload — so the
   * frontend had to create a *new* `person` and mark the lead resolved, which
   * gives the client a new id. Every comment, document, task, payment and
   * message filed against the lead then hangs off a record the UI no longer
   * shows. That is precisely the discontinuity the architecture is supposed to
   * avoid, and it was caused by a missing route rather than a decision.
   *
   * Deliberately a separate verb rather than a relaxed DTO: conversion is
   * explicit, audited as its own action, and validated against what may become
   * what.
   */
  async convertEntity(
    id: string,
    tenantId: string,
    // Required, not optional — see `getEntity`. A conversion rewrites `type`
    // and, on the allowlist's other branches, `status`; that is a write.
    actor: Actor,
    toType: EntityType,
    vertical?: string | null,
  ): Promise<UniversalEntity> {
    const entity = await this.entityRepo.findOne({ where: { id, tenantId } });
    if (!entity) {
      throw new NotFoundException('Entity not found');
    }

    this.access.assert(entity, actor, 'write');

    if (entity.type === toType) {
      throw new BadRequestException(`Entity is already of type '${toType}'`);
    }

    const permitted = CONVERTIBLE_TYPES.get(entity.type);
    if (!permitted?.has(toType)) {
      // Naming both halves, because "conversion not allowed" leaves the caller
      // guessing which end of it was wrong.
      const allowed = permitted?.size
        ? Array.from(permitted).join(', ')
        : 'nothing';
      throw new BadRequestException(
        `Cannot convert '${entity.type}' to '${toType}'. A '${entity.type}' may become: ${allowed}.`,
      );
    }

    const fromType = entity.type;
    entity.type = toType;

    // A record acquiring a lifecycle needs a state to be in, and one losing its
    // lifecycle should not keep a stale `status` that now means nothing.
    if (WORKABLE_TYPES.has(toType) && !entity.status) {
      entity.status = EntityStatus.OPEN;
    } else if (!WORKABLE_TYPES.has(toType)) {
      entity.status = null;
    }

    // Keep the trail on the record itself. `verticalAttributes` is where the
    // pack's vocabulary lives, and the previous type is part of this record's
    // history — a client who used to be a lead is a fact a caseworker asks
    // about.
    entity.verticalAttributes = deepMerge(entity.verticalAttributes ?? {}, {
      conversion: {
        fromType,
        toType,
        convertedAt: new Date().toISOString(),
      },
    });

    const saved = await this.entityRepo.save(entity);
    this.logger.log(`Entity ${id} converted: ${fromType} → ${toType}`);

    // The search index carries `type`; leaving it stale would keep the record
    // answering to its old type in every filtered list.
    this.searchService.indexEntityData(saved).catch((err) => {
      this.logger.error('Failed to re-index converted entity:', err);
    });

    void vertical;
    return saved;
  }

  /**
   * The same filtered list, as CSV.
   *
   * Exported server-side because the frontend was building its file from
   * whatever rows the browser had already loaded — so an export of a filtered
   * list silently gave you page one of it, with no indication that was what
   * happened.
   *
   * Capped, and a capped export says so. A file that is quietly a prefix of the
   * answer is the same class of lie as a truncated count reported as exact
   * (CLAUDE.md §5.2), and worse in practice because it leaves the building.
   *
   * Builds its own query via `buildEntityListQuery` rather than delegating to
   * `listEntities` — delegating used to pass `limit: MAX_ROWS` (10,000)
   * straight into `listEntities`, which clamps whatever `limit` it receives
   * to 200 before the query runs. A firm exporting 600 matching records was
   * getting a 200-row file, and `X-Export-Truncated` never fired because
   * `total` was computed against that same 200-row page rather than the real
   * count. `getManyAndCount()`'s count query ignores `.take()`, so `total`
   * here is genuinely the full matching count regardless of the cap.
   */
  async exportEntitiesCsv(
    tenantId: string,
    filters: Parameters<CrmService['listEntities']>[1],
  ): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const MAX_ROWS = 10_000;

    // `page`/`limit` are accepted on the type (the controller shares one DTO
    // between the list and export routes) but not honoured here — an export
    // is the whole filtered set up to MAX_ROWS, not one page of it.
    const { page: _page, limit: _limit, ...listFilters } = filters ?? {};
    void _page;
    void _limit;

    const [items, total] = await this.buildEntityListQuery(tenantId, listFilters)
      .take(MAX_ROWS)
      .getManyAndCount();

    const headers = [
      'id',
      'type',
      'firstName',
      'lastName',
      'email',
      'phoneNumber',
      'status',
      'dueDate',
      'assignedTo',
      'createdAt',
      'updatedAt',
      // The vertical's own attributes, as JSON in one column. Flattening them
      // into columns would give every export a different shape depending on
      // which records happened to match — unusable for a spreadsheet.
      'verticalAttributes',
    ];

    const rows = items.map((e) => [
      e.id,
      e.type,
      e.firstName,
      e.lastName,
      e.email,
      e.phoneNumber,
      e.status,
      e.dueDate,
      e.assignedTo,
      e.createdAt,
      e.updatedAt,
      e.verticalAttributes ?? {},
    ]);

    return {
      csv: toCsv(headers, rows),
      rows: items.length,
      truncated: total > items.length,
    };
  }

  // ==================== DOCUMENT INTEGRATION ====================

  async getEntityDocuments(
    tenantId: string,
    entityId: string,
  ): Promise<Document[]> {
    return this.documentHubService.getCrmEntityDocuments(tenantId, entityId);
  }

  async attachDocument(
    tenantId: string,
    entityId: string,
    documentId: string,
    userId: string,
  ): Promise<Document> {
    // Verify the entity exists *in this tenant* — an existence check that
    // ignored the tenant would let a document be attached to an id from
    // another firm, and "entity exists" would have been the wrong question.
    const entity = await this.findEntityById(entityId, tenantId);
    if (!entity) {
      throw new BadRequestException('Entity not found');
    }

    return this.documentHubService.attachDocumentToEntity(
      documentId,
      'crm_entity',
      entityId,
      userId,
    );
  }

  async searchEntityDocuments(
    tenantId: string,
    entityId: string,
    query: string,
  ): Promise<any[]> {
    return this.documentHubService.searchDocuments(tenantId, query, {
      entityType: 'crm_entity',
      entityId,
    });
  }

  async getEntityDocumentStats(
    tenantId: string,
    entityId: string,
  ): Promise<{
    totalDocuments: number;
    totalSize: number;
    byType: Record<string, number>;
  }> {
    return this.documentHubService.getEntityDocumentStats(
      tenantId,
      'crm_entity',
      entityId,
    );
  }
}
