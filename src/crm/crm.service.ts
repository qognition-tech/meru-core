import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UniversalEntity } from './entities/universal-entity.entity';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { SearchService } from '../search/search.service';
import { CreateEntityInput } from '../common/types';
import { DocumentHubService } from '../documents/document-hub.service';
import { Document } from '../documents/entities/document.entity';

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
      for (const field of settings?.fields ?? []) {
        if (field.required && !dto.verticalAttributes?.[field.key]) {
          throw new BadRequestException(
            `Missing required vertical attribute: ${field.label} (${field.key})`,
          );
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

  async findEntityById(id: string): Promise<UniversalEntity | null> {
    return this.entityRepo.findOne({
      where: { id },
    });
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

    if (!entity) {
      throw new BadRequestException('Entity not found');
    }

    Object.assign(entity, updates);
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
