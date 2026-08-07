import {
  Injectable,
  BadRequestException,
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
import { Document } from '../documents/entities/document.entity';

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
]);

function defaultStatusFor(type: EntityType): EntityStatus | null {
  return WORKABLE_TYPES.has(type) ? EntityStatus.OPEN : null;
}

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
  ) {}

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
    if (filters.dueAfter)
      qb.andWhere('e."dueDate" >= :dueAfter', { dueAfter: filters.dueAfter });
    if (filters.dueBefore)
      qb.andWhere('e."dueDate" <= :dueBefore', {
        dueBefore: filters.dueBefore,
      });

    // Nulls last so undated records do not crowd out what is actually due.
    const [items, total] = await qb
      .orderBy('e."dueDate"', 'ASC', 'NULLS LAST')
      .addOrderBy('e."createdAt"', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }

  async findEntityById(id: string): Promise<UniversalEntity | null> {
    return this.entityRepo.findOne({
      where: { id },
    });
  }

  /**
   * Tenant-scoped fetch. Unlike `findEntityById`, this cannot return another
   * tenant's row and 404s rather than yielding null, so controllers do not each
   * have to remember the scoping.
   */
  async getEntity(id: string, tenantId: string): Promise<UniversalEntity> {
    const entity = await this.entityRepo.findOne({ where: { id, tenantId } });
    if (!entity) throw new NotFoundException('Entity not found');
    return entity;
  }

  async deleteEntity(id: string, tenantId: string): Promise<void> {
    const entity = await this.entityRepo.findOne({
      where: { id, tenantId },
    });

    if (!entity) {
      throw new BadRequestException('Entity not found');
    }

    await this.entityRepo.remove(entity);
    this.logger.log(`Entity deleted: ${id}`);
  }

  async updateEntity(
    id: string,
    tenantId: string,
    updates: Partial<UniversalEntity>,
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

    // `verticalAttributes` merges rather than replaces. A PATCH that sends one
    // attribute must not silently drop every other attribute the pack stored —
    // `Object.assign` on the whole bag would do exactly that.
    const { verticalAttributes, ...rest } = updates;
    Object.assign(entity, rest);

    if (verticalAttributes) {
      entity.verticalAttributes = {
        ...(entity.verticalAttributes ?? {}),
        ...verticalAttributes,
      };
    }

    const updated = await this.entityRepo.save(entity);

    this.logger.log(`Entity updated: ${id}`);

    return updated;
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
    // Verify entity exists
    const entity = await this.findEntityById(entityId);
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
