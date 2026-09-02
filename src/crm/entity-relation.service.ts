import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EntityRelation } from './entities/entity-relation.entity';
import {
  EntityStatus,
  UniversalEntity,
} from './entities/universal-entity.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { CrmAccessService } from './crm-access.service';
import { Actor } from '../common/access';

/** One `relationships[]` entry, as the pack declares it. */
export interface RelationshipDefinition {
  key: string;
  label: string;
  fromType: string;
  toType: string;
  cardinality?: 'one_to_one' | 'one_to_many' | 'many_to_many';
  inverseLabel?: string;
  blocksCompletion?: boolean;
}

export interface TraversalResult {
  entityId: string;
  outgoing: Array<{
    relationKey: string;
    label: string;
    entity: UniversalEntity;
  }>;
  /** The direction the jsonb array could not answer: what points *at* this. */
  incoming: Array<{
    relationKey: string;
    label: string;
    entity: UniversalEntity;
  }>;
}

/** Statuses that mean "finished". Anything else is still open. */
const CLOSED_STATUSES = [
  EntityStatus.RESOLVED,
  EntityStatus.CLOSED,
  EntityStatus.CANCELLED,
];

/**
 * Typed edges between entities, defined by the pack and enforced by core.
 *
 * Document relationships, task and milestone dependencies and counterparty
 * links are one shape (docs/FEATURE_PARITY_MAP.md §5, item 7). The vertical
 * says which types may be linked and what the link means; core stores the edge
 * and enforces cardinality and completion blocking.
 */
@Injectable()
export class EntityRelationService {
  private readonly logger = new Logger(EntityRelationService.name);

  constructor(
    @InjectRepository(EntityRelation)
    private readonly relationRepo: Repository<EntityRelation>,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    private readonly packs: VerticalPackService,
    private readonly access: CrmAccessService,
  ) {}

  /**
   * Create an edge, refusing anything the pack does not describe.
   *
   * The validation is the point: the jsonb array this replaces accepted any
   * `type` string, so a typo produced an edge that existed, traversed and
   * matched no definition — invisible until someone wondered why a dependency
   * was not blocking anything.
   */
  async link(
    tenantId: string,
    // Required — see `CrmAccessService`. The "from" entity is the parent this
    // whole route hangs off (`POST /crm/entities/:id/relations`), so it is
    // what gets the ownership check; an `own`-scope caller may only manage
    // relations on records assigned to them, matching the rest of this
    // resource's model.
    actor: Actor,
    vertical: string | null,
    relationKey: string,
    fromId: string,
    toId: string,
    createdBy?: string,
  ): Promise<EntityRelation> {
    if (fromId === toId) {
      // A self-edge on a blocking relation is a task that can never complete.
      throw new BadRequestException('An entity cannot be related to itself');
    }

    const definition = await this.definition(vertical, relationKey);
    const [from, to] = await Promise.all([
      this.entity(tenantId, fromId),
      this.entity(tenantId, toId),
    ]);

    this.access.assert(from, actor, 'read');
    // **Both ends, not just the parent.** Checking only `from` was a privilege
    // escalation, not merely an incomplete check: an `own`-scope caller who
    // owns exactly one record could link it to *any* id in the tenant they
    // could guess, and then read that record back in full through `traverse()`
    // below — `verticalAttributes` included, which on ImmiStack is where
    // passport and visa data lives. Ownership of a record you already hold
    // must never become a key to one you do not.
    this.access.assert(to, actor, 'read');

    if (from.type !== definition.fromType || to.type !== definition.toType) {
      throw new BadRequestException(
        `Relation '${relationKey}' links ${definition.fromType} → ` +
          `${definition.toType}, not ${from.type} → ${to.type}`,
      );
    }

    const existing = await this.relationRepo.findOne({
      where: { tenantId, relationKey, fromId, toId },
    });
    // Idempotent: linking twice is what a double-clicked button does, and it
    // is not an error worth showing anyone.
    if (existing) return existing;

    await this.enforceCardinality(tenantId, definition, fromId, toId);

    return this.relationRepo.save(
      this.relationRepo.create({
        tenantId,
        relationKey,
        fromId,
        fromType: from.type,
        toId,
        toType: to.type,
        createdBy: createdBy ?? null,
      }),
    );
  }

  async unlink(
    tenantId: string,
    actor: Actor,
    relationKey: string,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const from = await this.entity(tenantId, fromId);
    this.access.assert(from, actor, 'read');
    await this.relationRepo.delete({ tenantId, relationKey, fromId, toId });
  }

  /**
   * Everything linked to this entity, both directions.
   *
   * The inverse direction is labelled with the pack's `inverseLabel` when it
   * has one, so a UI can render "blocks" one way and "blocked by" the other
   * from a single definition rather than two mirrored ones.
   */
  async traverse(
    tenantId: string,
    actor: Actor,
    vertical: string | null,
    entityId: string,
  ): Promise<TraversalResult> {
    const parent = await this.entity(tenantId, entityId);
    this.access.assert(parent, actor, 'read');

    const definitions = await this.definitions(vertical);
    const byKey = new Map(definitions.map((d) => [d.key, d]));

    const [out, into] = await Promise.all([
      this.relationRepo.find({ where: { tenantId, fromId: entityId } }),
      this.relationRepo.find({ where: { tenantId, toId: entityId } }),
    ]);

    const ids = [...out.map((r) => r.toId), ...into.map((r) => r.fromId)];
    const entities = ids.length
      ? await this.entityRepo.find({ where: { tenantId, id: In(ids) } })
      : [];

    // **Filter per row, not just on the parent.** Reaching this point means the
    // caller may read the record the traversal started from — it says nothing
    // about the records on the other end of each edge, and this method returns
    // whole `UniversalEntity` rows, `verticalAttributes` and all. Without this
    // filter, being able to read one record made every record it links to
    // readable, which turned a relation into a lateral-movement primitive.
    //
    // Dropping an unreadable row silently is correct here: the `flatMap`s below
    // already skip an id missing from this map, so an inaccessible neighbour is
    // simply not part of the graph this caller can see. Raising instead would
    // confirm the record exists, which is the disclosure 404-not-403 avoids
    // everywhere else in this service.
    const entityById = new Map(
      entities
        .filter((e) => this.access.canAccess(e, actor, 'read'))
        .map((e) => [e.id, e]),
    );

    return {
      entityId,
      outgoing: out.flatMap((r) => {
        const entity = entityById.get(r.toId);
        if (!entity) return [];
        return [
          {
            relationKey: r.relationKey,
            label: byKey.get(r.relationKey)?.label ?? r.relationKey,
            entity,
          },
        ];
      }),
      incoming: into.flatMap((r) => {
        const entity = entityById.get(r.fromId);
        if (!entity) return [];
        const definition = byKey.get(r.relationKey);
        return [
          {
            relationKey: r.relationKey,
            label:
              definition?.inverseLabel ??
              (definition ? `${definition.label} (inverse)` : r.relationKey),
            entity,
          },
        ];
      }),
    };
  }

  /**
   * Entities that must finish before this one may.
   *
   * This is what makes a dependency a dependency rather than a note. Called
   * before a status change to a closed state; an empty array means nothing is
   * in the way.
   */
  async completionBlockers(
    tenantId: string,
    actor: Actor,
    vertical: string | null,
    entityId: string,
  ): Promise<UniversalEntity[]> {
    const parent = await this.entity(tenantId, entityId);
    this.access.assert(parent, actor, 'read');

    // Disclosure view: only the blockers this caller may actually read. See
    // `openBlockers` for why the two are deliberately not the same list.
    return (await this.openBlockers(tenantId, vertical, entityId)).filter((b) =>
      this.access.canAccess(b, actor, 'read'),
    );
  }

  /**
   * Every open blocker, **unfiltered by who is asking**.
   *
   * Kept separate from {@link completionBlockers} because the two questions
   * genuinely differ, and collapsing them breaks one or the other:
   *
   * - *"What may I show this caller?"* must hide records they cannot read,
   *   or a relation becomes a way to read someone else's case.
   * - *"May this record be completed?"* must count **every** blocker, readable
   *   or not. Filtering here would mean a blocker a caller cannot see is a
   *   blocker that does not stop them — an applicant could close a matter that
   *   is genuinely blocked, simply because the thing blocking it belongs to
   *   someone else.
   *
   * So the guard counts this list and the API renders the other one.
   */
  private async openBlockers(
    tenantId: string,
    vertical: string | null,
    entityId: string,
  ): Promise<UniversalEntity[]> {
    const blocking = (await this.definitions(vertical)).filter(
      (d) => d.blocksCompletion,
    );
    if (!blocking.length) return [];

    const edges = await this.relationRepo.find({
      where: {
        tenantId,
        fromId: entityId,
        relationKey: In(blocking.map((d) => d.key)),
      },
    });
    if (!edges.length) return [];

    const targets = await this.entityRepo.find({
      where: { tenantId, id: In(edges.map((e) => e.toId)) },
    });

    // A null status means the type is not workable — a tag or a note — and
    // cannot block anything. Treating null as open would let an attached note
    // freeze a case forever.
    return targets.filter(
      (t) => t.status !== null && !CLOSED_STATUSES.includes(t.status),
    );
  }

  /**
   * Throw if anything blocks completion. The guard CRM calls on close.
   */
  async assertCompletable(
    tenantId: string,
    actor: Actor,
    vertical: string | null,
    entityId: string,
  ): Promise<void> {
    // The *unfiltered* list on purpose — a blocker the caller cannot read is
    // still a blocker. Counting only what they can see would let an applicant
    // close a matter that another party's open record is holding open.
    const blockers = await this.openBlockers(tenantId, vertical, entityId);
    if (!blockers.length) return;

    // Truthful count, but name only the records this caller may already read.
    // The fact that something blocks is information they are entitled to — it
    // is why their action failed. *Which* record it is, when it belongs to
    // someone else, is not.
    const nameable = blockers.filter((b) =>
      this.access.canAccess(b, actor, 'read'),
    );
    const named = nameable
      .slice(0, 3)
      .map((b) => `${b.type} ${b.id.slice(0, 8)}`)
      .join(', ');
    const detail = named
      ? ` (${named}${nameable.length > 3 ? ', …' : ''})`
      : '';

    throw new BadRequestException(
      `Cannot complete: ${blockers.length} related record(s) are still open${detail}`,
    );
  }

  private async enforceCardinality(
    tenantId: string,
    definition: RelationshipDefinition,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const cardinality = definition.cardinality ?? 'many_to_many';
    if (cardinality === 'many_to_many') return;

    const outgoing = await this.relationRepo.count({
      where: { tenantId, relationKey: definition.key, fromId },
    });
    if (outgoing > 0) {
      throw new BadRequestException(
        `Relation '${definition.key}' is ${cardinality}: ` +
          `${fromId.slice(0, 8)} is already linked.`,
      );
    }

    if (cardinality === 'one_to_one') {
      // Only one_to_one constrains the target side too. one_to_many
      // deliberately allows many sources to point at one target.
      const incoming = await this.relationRepo.count({
        where: { tenantId, relationKey: definition.key, toId },
      });
      if (incoming > 0) {
        throw new BadRequestException(
          `Relation '${definition.key}' is one_to_one: ` +
            `${toId.slice(0, 8)} is already linked.`,
        );
      }
    }
  }

  private async definitions(
    vertical: string | null,
  ): Promise<RelationshipDefinition[]> {
    return (
      (await this.packs.section<RelationshipDefinition[]>(
        vertical,
        'relationships',
      )) ?? []
    );
  }

  private async definition(
    vertical: string | null,
    key: string,
  ): Promise<RelationshipDefinition> {
    const all = await this.definitions(vertical);
    const found = all.find((d) => d.key === key);

    if (!found) {
      throw new BadRequestException(
        `Relation '${key}' is not defined in the ${vertical ?? 'unknown'} pack` +
          (all.length
            ? ` (available: ${all.map((d) => d.key).join(', ')})`
            : ' — the pack defines no relationships'),
      );
    }

    return found;
  }

  private async entity(tenantId: string, id: string): Promise<UniversalEntity> {
    const found = await this.entityRepo.findOne({ where: { tenantId, id } });
    if (!found) throw new NotFoundException(`Entity ${id} not found`);
    return found;
  }
}
