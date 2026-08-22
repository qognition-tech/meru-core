import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { S3 } from 'aws-sdk';
import { randomUUID } from 'node:crypto';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  Document,
  DocumentStatus,
  DocumentEncryption,
  DocumentType,
} from './entities/document.entity';
import {
  DocumentVersion,
  VersionStatus,
} from './entities/document-version.entity';
import {
  DocumentMetadata,
  MetadataType,
} from './entities/document-metadata.entity';
import { User } from '../iam/entities/user.entity';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { DocumentAccessService } from './document-access.service';
import type { Actor } from '../common/access';

// Exported because the controller now returns it directly (it used to be
// re-boxed into an inline `{ success, data }` literal, which hid the type).
export interface UploadResult {
  document: Document;
  version: DocumentVersion;
  url?: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private s3: S3;

  constructor(
    @InjectRepository(Document)
    private documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentMetadata)
    private metadataRepo: Repository<DocumentMetadata>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private configService: ConfigService,
    private dataSource: DataSource,
    private orchestrationService: OrchestrationService,
    private access: DocumentAccessService,
  ) {
    this.s3 = new S3({
      accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      region: this.configService.get('AWS_REGION', 'us-east-1'),
    });
  }

  async upload(
    file: Express.Multer.File,
    dto: UploadDocumentDto,
    tenantId: string,
    userId: string,
  ): Promise<UploadResult> {
    this.logger.log(`Uploading document: ${dto.name} for tenant: ${tenantId}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      const fileType =
        dto.fileType ||
        this.detectFileType(dto.originalFileName || file.originalname);
      const fileSize = file.size;

      const encryptionLevel = dto.requiredEncryption || DocumentEncryption.NONE;
      const encrypted = await this.encryptFile(file.buffer, encryptionLevel);

      const documentSlug = this.generateSlug(dto.name, tenantId);

      const s3Key = this.generateS3Key(tenantId, documentSlug, 1, fileType);
      const s3UploadResult = await this.uploadToS3(
        encrypted,
        s3Key,
        file.mimetype,
      );

      const document = queryRunner.manager.create(Document, {
        id: randomUUID(),
        tenantId,
        name: dto.name,
        slug: documentSlug,
        fileType,
        originalFileName: dto.originalFileName || file.originalname,
        fileSize,
        mimeType: file.mimetype,
        status: DocumentStatus.ACTIVE,
        encryption: encryptionLevel,
        requiredEncryption: encryptionLevel,
        linkedEntityType: dto.linkedEntityType,
        linkedEntityId: dto.linkedEntityId,
        tags: dto.tags || [],
        metadata: dto.metadata || {},
        rbac: {
          owner: userId,
        },
        versionNumber: 1,
        uploadedById: userId,
        uploadedBy: user,
      });

      const version = queryRunner.manager.create(DocumentVersion, {
        id: randomUUID(),
        documentId: document.id,
        versionNumber: 1,
        status: VersionStatus.ACTIVE,
        s3Key: s3UploadResult.Key,
        s3Bucket: s3UploadResult.Bucket,
        fileSize: encrypted.length,
        checksum: this.calculateChecksum(encrypted),
        encryptionKey:
          encryptionLevel !== DocumentEncryption.NONE
            ? this.getEncryptionKey()
            : undefined,
        encryptionAlgorithm:
          encryptionLevel !== DocumentEncryption.NONE
            ? 'aes-256-gcm'
            : undefined,
        changeDescription: dto.changeDescription || 'Initial upload',
        changeMetadata: {
          changedBy: userId,
          changeReason: 'Initial upload',
        },
        uploadedById: userId,
        uploadedBy: user,
      });

      document.currentVersionId = version.id;

      await queryRunner.manager.save(document);
      await queryRunner.manager.save(version);

      await queryRunner.commitTransaction();

      if (dto.triggerAI) {
        // `null`, not the uploader: this runs after the response, on a document
        // that was just created in this transaction. There is no read to scope
        // and no user waiting, so passing an Actor here would imply an
        // authorisation decision that is not being made.
        this.triggerAIAnalysis(document.id, tenantId, null);
      }

      return {
        document,
        version,
        url: this.getPresignedUrl(s3UploadResult.Key),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Upload failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async create(
    dto: CreateDocumentDto,
    tenantId: string,
    userId: string,
  ): Promise<Document> {
    this.logger.log(`Creating document: ${dto.name} for tenant: ${tenantId}`);

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const documentSlug = this.generateSlug(dto.name, tenantId);

    const document = this.documentRepo.create({
      id: randomUUID(),
      tenantId,
      name: dto.name,
      slug: documentSlug,
      fileType: dto.fileType,
      originalFileName: dto.originalFileName,
      fileSize: dto.fileSize,
      mimeType: dto.mimeType,
      status: DocumentStatus.ACTIVE,
      encryption: DocumentEncryption.NONE,
      requiredEncryption: dto.requiredEncryption || DocumentEncryption.NONE,
      linkedEntityType: dto.linkedEntityType,
      linkedEntityId: dto.linkedEntityId,
      tags: dto.tags || [],
      metadata: dto.metadata || {},
      rbac: {
        owner: userId,
      },
      versionNumber: 0,
      currentVersionId: '',
      uploadedById: userId,
      uploadedBy: user,
    });

    return this.documentRepo.save(document);
  }

  async createNewVersion(
    documentId: string,
    file: Express.Multer.File,
    changeDescription: string,
    tenantId: string,
    actor: Actor,
  ): Promise<UploadResult> {
    const userId = actor.id;
    this.logger.log(`Creating new version for document: ${documentId}`);

    const document = await this.documentRepo.findOne({
      where: { id: documentId, tenantId },
    });
    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'write');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      const newVersionNumber = document.versionNumber + 1;
      const encryptionLevel = document.requiredEncryption;
      const encrypted = await this.encryptFile(file.buffer, encryptionLevel);

      const s3Key = this.generateS3Key(
        tenantId,
        document.slug,
        newVersionNumber,
        document.fileType,
      );
      const s3UploadResult = await this.uploadToS3(
        encrypted,
        s3Key,
        file.mimetype,
      );

      const version = queryRunner.manager.create(DocumentVersion, {
        id: randomUUID(),
        documentId: document.id,
        versionNumber: newVersionNumber,
        status: VersionStatus.ACTIVE,
        s3Key: s3UploadResult.Key,
        s3Bucket: s3UploadResult.Bucket,
        fileSize: encrypted.length,
        checksum: this.calculateChecksum(encrypted),
        encryptionKey:
          encryptionLevel !== DocumentEncryption.NONE
            ? this.getEncryptionKey()
            : undefined,
        encryptionAlgorithm:
          encryptionLevel !== DocumentEncryption.NONE
            ? 'aes-256-gcm'
            : undefined,
        changeDescription,
        changeMetadata: {
          changedBy: userId,
          changeReason: changeDescription,
        },
        uploadedById: userId,
        uploadedBy: user,
      });

      await queryRunner.manager.save(version);

      document.versionNumber = newVersionNumber;
      document.currentVersionId = version.id;
      document.fileSize = file.size;
      document.updatedAt = new Date();

      await queryRunner.manager.save(document);

      await queryRunner.commitTransaction();

      return {
        document,
        version,
        url: this.getPresignedUrl(s3UploadResult.Key),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Create version failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(
    tenantId: string,
    searchDto: SearchDocumentsDto,
    actor: Actor,
  ): Promise<{
    documents: Document[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      query,
      fileTypes,
      status,
      encryption,
      linkedEntityType,
      linkedEntityId,
      tags,
      includeAI,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = searchDto;

    const queryBuilder = this.documentRepo.createQueryBuilder('document');

    queryBuilder.where('document.tenantId = :tenantId', { tenantId });

    if (status) {
      queryBuilder.andWhere('document.status = :status', { status });
    }

    if (encryption) {
      queryBuilder.andWhere('document.encryption = :encryption', {
        encryption,
      });
    }

    if (linkedEntityType) {
      queryBuilder.andWhere('document.linkedEntityType = :linkedEntityType', {
        linkedEntityType,
      });
    }

    if (linkedEntityId) {
      queryBuilder.andWhere('document.linkedEntityId = :linkedEntityId', {
        linkedEntityId,
      });
    }

    if (fileTypes && fileTypes.length > 0) {
      queryBuilder.andWhere('document.fileType IN (:...fileTypes)', {
        fileTypes,
      });
    }

    if (tags && tags.length > 0) {
      queryBuilder.andWhere('document.tags @> :tags', { tags });
    }

    if (query) {
      queryBuilder.andWhere(
        '(document.name ILIKE :query OR document.originalFileName ILIKE :query OR document.slug ILIKE :query)',
        { query: `%${query}%` },
      );

      if (includeAI) {
        queryBuilder.orWhere('document.aiAnalysis::text ILIKE :query', {
          query: `%${query}%`,
        });
      }
    }

    // User scoping, not just tenant scoping. RLS stops tenant A reading tenant
    // B; nothing but this stops one of tenant A's clients listing the whole
    // firm's document table. Applied to the query rather than filtered after,
    // so `total` is also the caller's total and paging does not walk documents
    // they cannot open.
    await this.access.applyScope(queryBuilder, tenantId, actor);

    queryBuilder
      .orderBy(`document.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [documents, total] = await queryBuilder.getManyAndCount();

    return {
      documents,
      total,
      page,
      limit,
    };
  }

  async findOne(
    id: string,
    tenantId: string,
    actor: Actor,
  ): Promise<Document> {
    const document = await this.documentRepo.findOne({
      where: { id, tenantId },
      relations: ['versions', 'uploadedBy'],
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'read');

    return document;
  }

  async getVersions(
    documentId: string,
    tenantId: string,
    actor: Actor,
  ): Promise<DocumentVersion[]> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId, tenantId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'read');

    return this.versionRepo.find({
      where: { documentId },
      order: { versionNumber: 'DESC' },
    });
  }

  async getVersion(
    documentId: string,
    versionId: string,
    tenantId: string,
    actor: Actor,
  ): Promise<DocumentVersion> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId, tenantId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'read');

    const version = await this.versionRepo.findOne({
      where: { id: versionId, documentId },
    });

    if (!version) {
      throw new NotFoundException('Document version not found');
    }

    return version;
  }

  /**
   * A signed URL for the bytes.
   *
   * `tenantId` and `actor` are required, and that is a fix rather than
   * tidiness: they used to be optional, and when either was absent the whole
   * access check was skipped *and* the fallback lookup dropped the tenant
   * filter — so the one route that hands out the actual file content was the
   * one with the weakest guard.
   */
  async downloadUrl(
    documentId: string,
    versionId: string | undefined,
    tenantId: string,
    actor: Actor,
  ): Promise<string> {
    let version: DocumentVersion | null = null;

    const document = await this.documentRepo.findOne({
      where: { id: documentId, tenantId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'read');

    if (versionId) {
      version = await this.versionRepo.findOne({
        where: { id: versionId, documentId },
      });
    } else {
      version = await this.versionRepo.findOne({
        where: { id: document.currentVersionId },
      });
    }

    if (!version) {
      throw new NotFoundException('Document version not found');
    }

    return this.getPresignedUrl(version.s3Key);
  }

  async update(
    id: string,
    dto: UpdateDocumentDto,
    tenantId: string,
    actor: Actor,
  ): Promise<Document> {
    const document = await this.documentRepo.findOne({
      where: { id, tenantId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'write');

    Object.assign(document, dto);

    return this.documentRepo.save(document);
  }

  async remove(id: string, tenantId: string, actor: Actor): Promise<void> {
    const document = await this.documentRepo.findOne({
      where: { id, tenantId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.checkAccess(document, actor, 'delete');

    document.status = DocumentStatus.DELETED;
    document.deletedAt = new Date();

    await this.documentRepo.save(document);
  }

  /**
   * Run document intelligence over a stored document.
   *
   * `actor` is checked before anything is read, because an analysis result is a
   * derived read of the file: summarising a document the caller may not open
   * discloses it just as surely as downloading it would.
   *
   * The check is skipped only for the internal call from `upload`, where the
   * caller has just supplied the bytes — passed as `null` explicitly so that
   * omitting an actor can never be mistaken for "no check needed".
   */
  /**
   * "Analyse this document" — which the platform cannot yet do.
   *
   * The previous body called `performIntelligentSearch('')`, discarded the
   * answer, and wrote `summary: 'Document analyzed successfully', riskLevel:
   * 'low'` onto the record. Nothing had been read. A document that looked
   * assessed and unremarkable is exactly the §5.2 failure: unknown reported
   * as a positive. `DocIntelEngine` (POST /engines/doc-intel) does real
   * extraction and fraud signalling; wiring it here — download, hand the
   * bytes to the engine, store `extractedFields` and `fraudSignals` — is the
   * real implementation, and it is not done yet.
   *
   * Until then this performs the access check, writes nothing, and reports
   * `analyzed: false` with the reason. The route turns that into a 503.
   */
  async triggerAIAnalysis(
    documentId: string,
    tenantId: string,
    actor: Actor | null,
  ): Promise<{ analyzed: false; unavailableReason: string }> {
    // Outside any try: an authorisation failure swallowed into a success is a
    // denial reported as a success.
    const document = await this.documentRepo.findOne({
      where: { id: documentId, tenantId },
      relations: ['uploadedBy'],
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (actor) {
      await this.checkAccess(document, actor, 'read');
    }

    const unavailableReason =
      'Document analysis is not implemented: DocIntelEngine is not wired to ' +
      'stored documents, so nothing was read and nothing was written to ' +
      'aiAnalysis. Use POST /engines/doc-intel with the file contents.';
    this.logger.warn(`AI analysis requested for ${documentId}: ${unavailableReason}`);
    return { analyzed: false, unavailableReason };
  }

  private async encryptFile(
    buffer: Buffer,
    level: DocumentEncryption,
  ): Promise<Buffer> {
    if (level === DocumentEncryption.NONE) {
      return buffer;
    }

    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.getEncryptionKey(), 'salt', 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]);
  }

  private async decryptFile(
    buffer: Buffer,
    key: string,
    algorithm: string,
  ): Promise<Buffer> {
    const iv = buffer.slice(0, 16);
    const authTag = buffer.slice(16, 32);
    const encrypted = buffer.slice(32);

    const decipher = crypto.createDecipheriv(
      algorithm,
      Buffer.from(key, 'base64'),
      iv,
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private async uploadToS3(
    buffer: Buffer,
    key: string,
    contentType?: string,
  ): Promise<S3.ManagedUpload.SendData> {
    return this.s3
      .upload({
        Bucket: this.configService.get('AWS_S3_BUCKET', 'meru-documents'),
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      })
      .promise();
  }

  private async downloadFile(key: string): Promise<Buffer> {
    const result = await this.s3
      .getObject({
        Bucket: this.configService.get('AWS_S3_BUCKET', 'meru-documents'),
        Key: key,
      })
      .promise();

    return result.Body as Buffer;
  }

  private getPresignedUrl(key: string, expiresIn: number = 3600): string {
    return this.s3.getSignedUrl('getObject', {
      Bucket: this.configService.get('AWS_S3_BUCKET', 'meru-documents'),
      Key: key,
      Expires: expiresIn,
    });
  }

  private generateS3Key(
    tenantId: string,
    slug: string,
    version: number,
    fileType: DocumentType,
  ): string {
    return `tenants/${tenantId}/documents/${slug}/v${version}.${fileType}`;
  }

  private generateSlug(name: string, tenantId: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const timestamp = Date.now();
    return `${base}-${timestamp}`;
  }

  private detectFileType(fileName: string): DocumentType {
    const ext = path.extname(fileName).toLowerCase().replace('.', '');
    const typeMap: Record<string, DocumentType> = {
      pdf: DocumentType.PDF,
      jpg: DocumentType.JPG,
      jpeg: DocumentType.JPEG,
      png: DocumentType.PNG,
      docx: DocumentType.DOCX,
      xlsx: DocumentType.XLSX,
      txt: DocumentType.TXT,
    };
    return typeMap[ext] || DocumentType.TXT;
  }

  private calculateChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  private getEncryptionKey(): string {
    return this.configService.get(
      'DOCUMENT_ENCRYPTION_KEY',
      'default-encryption-key-32-chars!',
    );
  }

  /**
   * Authorisation for one document.
   *
   * Delegates to `DocumentAccessService` so documents, the document hub and any
   * future caller cannot disagree about who may see what. This method used to
   * grant access to the uploader alone, which denied a caseworker the documents
   * on their own cases; `DocumentHubService.canAccessDocument` meanwhile
   * returned `true` unconditionally. One rule now answers both.
   */
  private async checkAccess(
    document: Document,
    actor: Actor,
    action: 'read' | 'write' | 'delete' | 'share',
  ): Promise<void> {
    await this.access.assert(document, actor, action);
  }
}
