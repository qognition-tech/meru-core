import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';
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
import { RequestDocumentUploadUrlDto } from './dto/request-upload-url.dto';
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
    // All bytes go through StorageService: it resolves the tenant's driver
    // (S3 or Supabase) and asserts the tenants/<tenantId>/ prefix on every
    // key. This service used to construct its own aws-sdk S3 client, which
    // bypassed both and meant the provider abstraction bought nothing.
    private storage: StorageService,
  ) {}

  async upload(
    file: Express.Multer.File,
    dto: UploadDocumentDto,
    tenantId: string,
    userId: string,
  ): Promise<UploadResult> {
    this.logger.log(`Uploading document: ${dto.name} for tenant: ${tenantId}`);

    // The user lookup and the storage write happen BEFORE any transaction
    // opens. The serverless pg pool is `{ max: 1 }` (app.module.ts): once a
    // transaction has checked out the only connection, any second acquire —
    // another repository read, or StorageDriverRegistry.forTenant()'s
    // tenant-pin lookup inside `storage.putObject` — blocks for the full
    // `connectionTimeoutMillis` (10s) and surfaces as a raw pool-timeout 500
    // ten seconds after the real answer (success, or a clean 503 when
    // storage is unconfigured) could have been known in under a second. This
    // also matches `/documents/upload-url`, which never opens a transaction
    // and answers in ~0.3s.
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

    const s3Key = this.generateObjectKey(tenantId, documentSlug, 1, fileType);
    const stored = await this.storage.putObject(tenantId, s3Key, encrypted, {
      contentType: file.mimetype,
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
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
        s3Key,
        s3Bucket: stored.bucket,
        storageProvider: stored.provider,
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
        url: await this.storage.signedReadUrl(tenantId, s3Key, stored.provider),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Upload failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Step one of the presigned-upload path: a short-TTL signed PUT URL and the
   * key it targets, so the browser can send the bytes straight to the bucket
   * instead of through `POST /documents/upload` — which routes through the
   * single Vercel function fronting this API and its own body-size ceiling
   * (CLAUDE.md §10). Scanned passports and multi-page PDFs routinely exceed
   * that ceiling; this route does not.
   *
   * Returns the storage key up front rather than requiring the caller to
   * recompute it: the browser echoes `storageKey`/`storageProvider`/
   * `storageBucket` back on the follow-up `POST /documents` call, which is
   * what finalises the document with a real, readable version. Until that
   * second call happens, the bytes sit in the bucket with no `Document`/
   * `DocumentVersion` row pointing at them — an orphaned object, not a
   * document, and never rendered as one.
   */
  async requestUploadUrl(
    dto: RequestDocumentUploadUrlDto,
    tenantId: string,
  ): Promise<{
    uploadUrl: string;
    storageKey: string;
    storageProvider: string;
    storageBucket: string;
    expiresInSeconds: number;
  }> {
    const fileType = dto.fileType || this.detectFileType(dto.originalFileName);
    const slug = this.generateSlug(dto.name, tenantId);
    const storageKey = this.generateObjectKey(tenantId, slug, 1, fileType);
    const expiresInSeconds = 300;

    const { uploadUrl, provider, bucket } =
      await this.storage.getUploadPresignedUrl(tenantId, storageKey, expiresInSeconds);

    return {
      uploadUrl,
      storageKey,
      storageProvider: provider,
      storageBucket: bucket,
      expiresInSeconds,
    };
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

    // A direct-to-bucket upload finalising here (see `requestUploadUrl`)
    // supplies all three; every other caller of this route supplies none.
    const directUpload =
      dto.storageKey && dto.storageProvider && dto.storageBucket
        ? {
            key: dto.storageKey,
            provider: dto.storageProvider,
            bucket: dto.storageBucket,
          }
        : null;
    if (!directUpload && (dto.storageKey || dto.storageProvider || dto.storageBucket)) {
      throw new BadRequestException(
        'storageKey, storageProvider and storageBucket must all be present ' +
          'together, or all absent.',
      );
    }

    // A client-supplied key must not be trusted just because it round-tripped
    // through this tenant's own token — assert it before it is ever written
    // into a row, the same discipline `StorageService` applies on every read
    // and write. `POST /documents/upload-url` only ever hands back a key
    // already under this prefix, so this only fires on a forged or stale one.
    if (directUpload) {
      this.storage.assertKeyBelongsToTenant(tenantId, directUpload.key);
    }

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
      versionNumber: directUpload ? 1 : 0,
      // No version row exists yet at this insert — even on the directUpload
      // path, the version below is created and back-filled onto `saved`
      // only after this row is written. `''` is not a valid uuid; Postgres
      // rejected it at parse time before the NOT NULL check ever ran
      // (`invalid input syntax for type uuid: ""`), 500ing every
      // POST /documents call unconditionally. `null` matches the column's
      // declared nullable state — see migration 1756410000000, which drops
      // the NOT NULL the column was created with.
      currentVersionId: null,
      uploadedById: userId,
      uploadedBy: user,
    });

    const saved = await this.documentRepo.save(document);

    if (directUpload) {
      const versionId = randomUUID();
      const version = this.versionRepo.create({
        id: versionId,
        documentId: saved.id,
        versionNumber: 1,
        status: VersionStatus.ACTIVE,
        s3Key: directUpload.key,
        s3Bucket: directUpload.bucket,
        storageProvider: directUpload.provider,
        fileSize: dto.fileSize,
        // The server never touched the bytes for a direct-to-bucket upload —
        // a checksum here would be a fabricated claim, not a computed one
        // (CLAUDE.md §5.2: unknown is never clear). Left unset, same as
        // `encryptionKey`/`encryptionAlgorithm` above for a non-encrypted
        // version, rather than a value nobody calculated.
        checksum: undefined,
        changeDescription: dto.changeDescription || 'Direct upload',
        changeMetadata: {
          changedBy: userId,
          changeReason: 'Direct upload via POST /documents/upload-url',
        },
        uploadedById: userId,
        uploadedBy: user,
      });
      await this.versionRepo.save(version);

      saved.currentVersionId = versionId;
      await this.documentRepo.save(saved);
    }

    return saved;
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

    // See upload() for why: the user lookup and the storage write happen
    // before any transaction opens, because the serverless pool is
    // `{ max: 1 }` and a second acquire while a transaction holds the only
    // connection blocks for the full connectionTimeoutMillis (10s).
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const newVersionNumber = document.versionNumber + 1;
    const encryptionLevel = document.requiredEncryption;
    const encrypted = await this.encryptFile(file.buffer, encryptionLevel);

    const s3Key = this.generateObjectKey(
      tenantId,
      document.slug,
      newVersionNumber,
      document.fileType,
    );
    const stored = await this.storage.putObject(tenantId, s3Key, encrypted, {
      contentType: file.mimetype,
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const version = queryRunner.manager.create(DocumentVersion, {
        id: randomUUID(),
        documentId: document.id,
        versionNumber: newVersionNumber,
        status: VersionStatus.ACTIVE,
        s3Key,
        s3Bucket: stored.bucket,
        storageProvider: stored.provider,
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
        url: await this.storage.signedReadUrl(tenantId, s3Key, stored.provider),
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
    } else if (document.currentVersionId) {
      version = await this.versionRepo.findOne({
        where: { id: document.currentVersionId },
      });
    }

    if (!version) {
      throw new NotFoundException('Document version not found');
    }

    return this.storage.signedReadUrl(
      tenantId,
      version.s3Key,
      version.storageProvider,
    );
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

  /**
   * Object key for a version. The `tenants/<tenantId>/` prefix is not a
   * naming convention: on Supabase it is the only thing separating tenants,
   * and StorageService refuses any key that lacks it.
   */
  private generateObjectKey(
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
