import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, FindOptionsWhere } from 'typeorm';
import {
  Document,
  DocumentStatus,
  DocumentType,
} from './entities/document.entity';
import { DocumentVersion } from './entities/document-version.entity';
import {
  DocumentMetadata,
  MetadataType,
} from './entities/document-metadata.entity';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';
import { PromptCategory } from '../ai/entities/ai-prompt.entity';
import {
  DocumentAccessService,
  type DocumentAction,
} from './document-access.service';
import type { Actor } from '../common/access';

export interface DocumentAttachment {
  documentId: string;
  versionId?: string;
  name: string;
  fileType: DocumentType;
  url: string;
  uploadedAt: Date;
}

export interface EntityDocumentsQuery {
  tenantId: string;
  entityType: string;
  entityId: string;
  documentType?: DocumentType;
  status?: DocumentStatus;
}

/** Shape of a single global-search hit returned by the SearchService. */
export interface DocumentSearchResult {
  id: string;
  type: string;
  searchableId: string;
  title: string;
  snippet: string;
  metadata?: {
    linkedEntityType?: string;
    linkedEntityId?: string;
    [key: string]: unknown;
  };
  score: number;
}

@Injectable()
export class DocumentHubService {
  private readonly logger = new Logger(DocumentHubService.name);

  constructor(
    @InjectRepository(Document)
    private documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentMetadata)
    private metadataRepo: Repository<DocumentMetadata>,
    private searchService: SearchService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
    // One authorisation decision, shared with DocumentsService.
    private access: DocumentAccessService,
  ) {}

  // ==================== CROSS-MODULE DOCUMENT ACCESS ====================

  /**
   * Get all documents attached to any entity (CRM, Workflow, Task, Form, etc.)
   */
  async getEntityDocuments(query: EntityDocumentsQuery): Promise<Document[]> {
    const where: FindOptionsWhere<Document> = {
      tenantId: query.tenantId,
      linkedEntityType: query.entityType,
      linkedEntityId: query.entityId,
    };

    if (query.documentType) {
      where.fileType = query.documentType;
    }

    if (query.status) {
      where.status = query.status;
    }

    return this.documentRepo.find({
      where,
      relations: ['versions', 'metadata'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Attach a document to any entity
   */
  async attachDocumentToEntity(
    documentId: string,
    entityType: string,
    entityId: string,
    _userId: string,
  ): Promise<Document> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    document.linkedEntityType = entityType;
    document.linkedEntityId = entityId;

    const updated = await this.documentRepo.save(document);

    // Index for search
    await this.indexDocumentForSearch(updated);

    this.logger.log(
      `Document ${documentId} attached to ${entityType}:${entityId}`,
    );

    return updated;
  }

  /**
   * Get documents for workflow instance
   */
  async getWorkflowDocuments(
    tenantId: string,
    workflowInstanceId: string,
  ): Promise<Document[]> {
    return this.getEntityDocuments({
      tenantId,
      entityType: 'workflow_instance',
      entityId: workflowInstanceId,
    });
  }

  /**
   * Get documents for CRM entity
   */
  async getCrmEntityDocuments(
    tenantId: string,
    entityId: string,
  ): Promise<Document[]> {
    return this.getEntityDocuments({
      tenantId,
      entityType: 'crm_entity',
      entityId,
    });
  }

  /**
   * Get documents for task
   */
  async getTaskDocuments(
    tenantId: string,
    taskId: string,
  ): Promise<Document[]> {
    return this.getEntityDocuments({
      tenantId,
      entityType: 'task',
      entityId: taskId,
    });
  }

  /**
   * Get documents for form submission
   */
  async getFormSubmissionDocuments(
    tenantId: string,
    submissionId: string,
  ): Promise<Document[]> {
    return this.getEntityDocuments({
      tenantId,
      entityType: 'form_submission',
      entityId: submissionId,
    });
  }

  // ==================== SEARCH INTEGRATION ====================

  /**
   * Index document for global search
   */
  async indexDocumentForSearch(document: Document): Promise<void> {
    try {
      // Get AI analysis of document content if available
      let aiSummary = '';
      try {
        const aiAnalysis = await this.aiService.execute({
          category: 'document_analysis' as PromptCategory,
          key: 'document_summary',
          input: JSON.stringify({
            documentName: document.name,
            fileType: document.fileType,
            metadata: document.metadata,
          }),
          context: { tenantId: document.tenantId },
        });
        aiSummary = aiAnalysis.result;
      } catch {
        this.logger.debug(
          `AI analysis not available for document ${document.id}`,
        );
      }

      const searchableData = {
        tenantId: document.tenantId,
        searchableType: 'document',
        searchableId: document.id,
        title: document.name,
        content: `${document.originalFileName} ${document.tags?.join(' ') || ''} ${aiSummary}`,
        metadata: {
          fileType: document.fileType,
          fileSize: document.fileSize,
          status: document.status,
          linkedEntityType: document.linkedEntityType,
          linkedEntityId: document.linkedEntityId,
          tags: document.tags,
          uploadedBy: document.uploadedBy,
        },
      };

      await this.searchService.indexEntityData(searchableData);
      this.logger.debug(`Document indexed for search: ${document.id}`);
    } catch (error) {
      this.logger.error(`Failed to index document: ${document.id}`, error);
    }
  }

  /**
   * Search documents across all entities
   */
  async searchDocuments(
    tenantId: string,
    query: string,
    filters?: {
      entityType?: string;
      entityId?: string;
      fileType?: DocumentType;
    },
    limit: number = 20,
  ): Promise<DocumentSearchResult[]> {
    const results = (await this.searchService.search(
      tenantId,
      query,
      limit,
    )) as DocumentSearchResult[];

    // Filter by entity if specified
    if (filters?.entityType || filters?.entityId) {
      return results.filter((result) => {
        if (
          filters.entityType &&
          result.metadata?.linkedEntityType !== filters.entityType
        ) {
          return false;
        }
        if (
          filters.entityId &&
          result.metadata?.linkedEntityId !== filters.entityId
        ) {
          return false;
        }
        return true;
      });
    }

    return results;
  }

  // ==================== AI INTEGRATION ====================

  /**
   * Analyze document with AI
   */
  async analyzeDocument(
    documentId: string,
  ): Promise<{ success: boolean; analysis: unknown }> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    try {
      // Extract text content (placeholder - in production, use OCR or text extraction)
      const analysis = await this.aiService.execute({
        category: 'document_analysis' as PromptCategory,
        key: 'document_extraction',
        input: JSON.stringify({
          documentId: document.id,
          name: document.name,
          fileType: document.fileType,
          metadata: document.metadata,
        }),
        context: { tenantId: document.tenantId },
      });

      // Store analysis in metadata
      const metadata = this.metadataRepo.create({
        documentId: document.id,
        documentVersionId: document.currentVersionId,
        type: MetadataType.AI_EXTRACTION,
        data: {
          key: 'analysis',
          value: analysis.result,
        },
      });

      await this.metadataRepo.save(metadata);

      return {
        success: true,
        analysis: JSON.parse(analysis.result) as unknown,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to analyze document: ${documentId}`, error);
      throw new BadRequestException(`AI analysis failed: ${message}`);
    }
  }

  /**
   * Extract data from document using AI
   */
  async extractDocumentData(
    documentId: string,
    extractionSchema: Record<string, any>,
  ): Promise<any> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    try {
      const extraction = await this.aiService.execute({
        category: 'data_extraction' as any,
        key: 'document_data_extraction',
        input: JSON.stringify({
          documentId: document.id,
          name: document.name,
          fileType: document.fileType,
          schema: extractionSchema,
        }),
        context: { tenantId: document.tenantId },
      });

      return {
        success: true,
        extractedData: JSON.parse(extraction.result),
      };
    } catch (error) {
      this.logger.error(
        `Failed to extract data from document: ${documentId}`,
        error,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==================== BATCH OPERATIONS ====================

  /**
   * Get documents by IDs
   */
  async getDocumentsByIds(
    tenantId: string,
    documentIds: string[],
  ): Promise<Document[]> {
    return this.documentRepo.find({
      where: {
        tenantId,
        id: In(documentIds),
      },
      relations: ['versions'],
    });
  }

  /**
   * Copy documents to another entity
   */
  async copyDocumentsToEntity(
    documentIds: string[],
    targetEntityType: string,
    targetEntityId: string,
    userId: string,
  ): Promise<Document[]> {
    const documents = await this.documentRepo.find({
      where: { id: In(documentIds) },
    });

    const updatedDocuments: Document[] = [];

    for (const doc of documents) {
      doc.linkedEntityType = targetEntityType;
      doc.linkedEntityId = targetEntityId;
      const updated = await this.documentRepo.save(doc);
      updatedDocuments.push(updated);

      // Re-index
      await this.indexDocumentForSearch(updated);
    }

    this.logger.log(
      `Copied ${documents.length} documents to ${targetEntityType}:${targetEntityId}`,
    );

    return updatedDocuments;
  }

  // ==================== DOCUMENT ACCESS CONTROL ====================

  /**
   * Check if this caller can access this document.
   *
   * This used to end in `return true; // Simplified for now` — it answered
   * "yes" for every caller and every action. RLS scopes documents to a tenant
   * but NOT to a user inside it (CLAUDE.md §5.1), so on ImmiStack that was one
   * applicant able to open another applicant's passport. It survived because
   * it had no callers: a method named `canAccessDocument` that always returns
   * true is a trap for whoever wires it up next, not dead code.
   *
   * The decision now lives in `DocumentAccessService` so documents, the hub and
   * anything built later share ONE answer rather than each re-deriving it.
   *
   * The signature changed: it takes an `Actor` (`{id, roles}`), not a bare
   * `userId`, because a user id alone cannot express "staff may see the whole
   * tenant caseload, a client may see only their own case file". A caller
   * holding only an id was structurally unable to be authorised correctly.
   */
  async canAccessDocument(
    documentId: string,
    actor: Actor,
    requiredPermission: DocumentAction = 'read',
  ): Promise<boolean> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
      relations: ['accessControl'],
    });

    if (!document) {
      return false;
    }

    return this.access.canAccess(document, actor, requiredPermission);
  }

  /**
   * Get document statistics for an entity
   */
  async getEntityDocumentStats(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<{
    totalDocuments: number;
    totalSize: number;
    byType: Record<string, number>;
  }> {
    const documents = await this.getEntityDocuments({
      tenantId,
      entityType,
      entityId,
    });

    const stats = {
      totalDocuments: documents.length,
      totalSize: documents.reduce((sum, doc) => sum + (doc.fileSize || 0), 0),
      byType: {} as Record<string, number>,
    };

    documents.forEach((doc) => {
      const type = doc.fileType || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    });

    return stats;
  }
}
