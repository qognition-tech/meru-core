import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Actor, scopeOf } from '../common/access';
import { StorageDriverRegistry } from './storage-driver.registry';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  StorageFile,
  FileVersion,
  MultipartUpload,
} from './entities/storage-file.entity';
import {
  StorageProvider,
  StorageClass,
  FileStatus,
  FileAccess,
  UploadOptions,
  FileSearchFilters,
  StorageMetrics,
  PresignedUrlOptions,
  ObjectStorageDriver,
} from './interfaces/storage.interface';
import * as crypto from 'crypto';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @InjectRepository(StorageFile)
    private fileRepo: Repository<StorageFile>,
    @InjectRepository(FileVersion)
    private versionRepo: Repository<FileVersion>,
    @InjectRepository(MultipartUpload)
    private multipartRepo: Repository<MultipartUpload>,
    private configService: ConfigService,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    // Injected, never `new`-ed here: which store holds a tenant's bytes is a
    // deployment decision the module makes once, not something every service
    // re-derives from env.
    private readonly drivers: StorageDriverRegistry,
  ) {}

  // ==================== RAW OBJECT ACCESS ====================
  //
  // For modules that keep their own file rows (DocumentsService keeps
  // documents/document_versions) and need the bytes moved without a second
  // `storage_files` row. The tenant-prefix assertion and the driver
  // resolution happen HERE, once, for every caller — that assertion is the
  // only isolation Supabase has (see assertTenantKey), so there must be no
  // second path to a driver that skips it.

  /** Write bytes under the caller's tenant prefix on the tenant's driver. */
  async putObject(
    tenantId: string,
    key: string,
    buffer: Buffer,
    options: { contentType?: string; metadata?: Record<string, any> } = {},
  ): Promise<{ provider: StorageProvider; bucket: string; etag: string }> {
    this.assertTenantKey(tenantId, key);
    const driver = await this.drivers.forTenant(tenantId);
    const { etag } = await driver.upload(buffer, key, {
      contentType: options.contentType,
      metadata: options.metadata,
      encrypt: true,
    });
    return { provider: driver.kind, bucket: driver.bucket, etag };
  }

  /** Read bytes the row recorded, from the driver the row recorded. */
  async getObject(
    tenantId: string,
    key: string,
    provider: StorageProvider | string | null | undefined,
  ): Promise<Buffer> {
    this.assertTenantKey(tenantId, key);
    return this.drivers.forFile(provider).download(key);
  }

  /** A short-lived, server-signed read URL. TTL is clamped (≤ 15 min). */
  async signedReadUrl(
    tenantId: string,
    key: string,
    provider: StorageProvider | string | null | undefined,
    options: { expiresInSeconds?: number; disposition?: 'inline' | 'attachment' } = {},
  ): Promise<string> {
    this.assertTenantKey(tenantId, key);
    return this.drivers.forFile(provider).getPresignedUrl(key, {
      fileId: key,
      expiresInSeconds: this.clampTtl(options.expiresInSeconds),
      responseDisposition: options.disposition,
    });
  }

  // ==================== UPLOAD OPERATIONS ====================

  async upload(options: UploadOptions): Promise<StorageFile> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const fileId = randomUUID();
      const versionId = randomUUID();
      const versionNumber = 1;

      // Generate storage key
      const key = this.generateKey(
        options.tenantId,
        fileId,
        versionNumber,
        options.fileName,
      );

      // Calculate checksum
      const checksum = this.calculateChecksum(options.buffer);

      // Upload to storage provider
      const provider = await this.drivers.forTenant(options.tenantId);
      this.assertTenantKey(options.tenantId, key);
      const uploadResult = await provider.upload(options.buffer, key, {
        contentType: options.mimeType,
        metadata: options.metadata,
        storageClass: options.storageClass,
        encrypt: options.encrypt,
      });

      // Create file entity
      const file = queryRunner.manager.create(StorageFile, {
        id: fileId,
        tenantId: options.tenantId,
        provider: provider.kind,
        bucket: provider.bucket,
        key,
        originalName: options.fileName,
        mimeType: options.mimeType,
        size: options.size,
        checksum,
        status: FileStatus.ACTIVE,
        storageClass: options.storageClass || StorageClass.STANDARD,
        access: options.access || FileAccess.PRIVATE,
        metadata: options.metadata || {},
        tags: options.tags || [],
        encryption: options.encrypt ? { algorithm: 'AES256' } : null,
        currentVersionId: versionId,
        createdById: options.userId,
        folder: options.folder || null,
        expiresAt: options.expiresInDays
          ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
        accessCount: 0,
      });

      // Create version entity
      const version = queryRunner.manager.create(FileVersion, {
        id: versionId,
        fileId,
        versionNumber,
        size: options.size,
        checksum,
        key,
        createdById: options.userId,
        isCurrent: true,
        changeDescription: 'Initial upload',
      });

      await queryRunner.manager.save(file);
      await queryRunner.manager.save(version);

      await queryRunner.commitTransaction();

      // Emit event
      this.eventEmitter.emit('storage.file.uploaded', {
        fileId,
        tenantId: options.tenantId,
        userId: options.userId,
        size: options.size,
      });

      this.logger.log(`File uploaded: ${fileId} (${options.size} bytes)`);
      return file;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Upload failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createVersion(
    fileId: string,
    buffer: Buffer,
    changeDescription: string,
    tenantId: string,
    actor: Actor,
  ): Promise<FileVersion> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');
    const userId = actor.id;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get next version number
      const lastVersion = await this.versionRepo.findOne({
        where: { fileId },
        order: { versionNumber: 'DESC' },
      });
      const versionNumber = (lastVersion?.versionNumber || 0) + 1;
      const versionId = randomUUID();

      // Generate key for new version
      const key = this.generateKey(
        tenantId,
        fileId,
        versionNumber,
        file.originalName,
      );
      const checksum = this.calculateChecksum(buffer);

      // A new version lands in the store the file already lives in.
      const provider = this.drivers.forFile(file.provider);
      this.assertTenantKey(tenantId, key);
      await provider.upload(buffer, key, {
        contentType: file.mimeType,
        metadata: file.metadata,
        storageClass: file.storageClass,
        encrypt: !!file.encryption,
      });

      // Mark previous version as not current
      await queryRunner.manager.update(
        FileVersion,
        { fileId, isCurrent: true },
        { isCurrent: false },
      );

      // Create new version
      const version = queryRunner.manager.create(FileVersion, {
        id: versionId,
        fileId,
        versionNumber,
        size: buffer.length,
        checksum,
        key,
        createdById: userId,
        isCurrent: true,
        changeDescription,
      });

      // Update file
      file.currentVersionId = versionId;
      file.size = buffer.length;
      file.checksum = checksum;
      file.key = key;
      file.updatedAt = new Date();

      await queryRunner.manager.save(version);
      await queryRunner.manager.save(file);

      await queryRunner.commitTransaction();

      this.logger.log(`Version created: ${fileId} v${versionNumber}`);
      return version;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ==================== DOWNLOAD OPERATIONS ====================

  async download(
    fileId: string,
    versionId: string | undefined,
    tenantId: string,
    actor: Actor,
  ): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'read');

    let version: FileVersion | null = null;
    if (versionId) {
      version = await this.versionRepo.findOne({
        where: { id: versionId, fileId },
      });
      if (!version) {
        throw new NotFoundException('Version not found');
      }
    } else {
      version = await this.versionRepo.findOne({
        where: { id: file.currentVersionId },
      });
    }

    if (!version) {
      throw new NotFoundException('File version not found');
    }

    const provider = this.drivers.forFile(file.provider);
    this.assertTenantKey(tenantId, version.key);
    const buffer = await provider.download(version.key);

    // Update access statistics
    await this.fileRepo.update(fileId, {
      lastAccessedAt: new Date(),
      accessCount: () => 'accessCount + 1',
    });

    return {
      buffer,
      fileName: file.originalName,
      mimeType: file.mimeType,
    };
  }

  async getPresignedUrl(
    fileId: string,
    options: PresignedUrlOptions & { tenantId: string; actor?: Actor },
  ): Promise<string> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId: options.tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    // `actor` is optional only for internal callers that have already
    // authorised (the documents service). Every HTTP path passes one.
    if (options.actor) {
      await this.checkAccess(file, options.actor, 'read');
    }

    let version: FileVersion | null = null;
    if (options.versionId) {
      version = await this.versionRepo.findOne({
        where: { id: options.versionId, fileId },
      });
    } else {
      version = await this.versionRepo.findOne({
        where: { id: file.currentVersionId },
      });
    }

    if (!version) {
      throw new NotFoundException('File version not found');
    }

    const provider = this.drivers.forFile(file.provider);
    this.assertTenantKey(options.tenantId, version.key);
    return provider.getPresignedUrl(version.key, {
      ...options,
      expiresInSeconds: this.clampTtl(options.expiresInSeconds),
    });
  }

  // ==================== MULTIPART UPLOAD ====================

  async initiateMultipartUpload(
    tenantId: string,
    fileName: string,
    mimeType: string,
    totalSize: number,
    userId: string,
    partSize: number = 100 * 1024 * 1024, // 100MB default
    metadata?: Record<string, any>,
  ): Promise<{
    uploadId: string;
    fileId: string;
    uploadUrls: { partNumber: number; url: string }[];
  }> {
    const fileId = randomUUID();
    const key = this.generateKey(tenantId, fileId, 1, fileName);

    // Multipart with browser-signed parts is an S3 concept; a provider without
    // it answers 501 here rather than handing back URLs that do not work.
    const provider = await this.drivers.forTenant(tenantId);
    const initiate = this.drivers.require(provider, 'initiateMultipartUpload');
    const signPart = this.drivers.require(provider, 'getPresignedUrlForPart');
    const uploadId = await initiate(key, { contentType: mimeType, metadata });

    const totalParts = Math.ceil(totalSize / partSize);
    const uploadUrls: { partNumber: number; url: string }[] = [];

    for (let i = 1; i <= totalParts; i++) {
      const url = await signPart(uploadId, key, i, 3600);
      uploadUrls.push({ partNumber: i, url });
    }

    // Create multipart upload record
    const multipartUpload = this.multipartRepo.create({
      uploadId,
      fileId,
      parts: uploadUrls.map((u) => ({
        partNumber: u.partNumber,
        size: partSize,
        status: 'pending' as const,
      })),
      partSize,
      totalParts,
      completedParts: 0,
      status: 'in_progress',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });

    await this.multipartRepo.save(multipartUpload);

    // Create placeholder file
    const file = this.fileRepo.create({
      id: fileId,
      tenantId,
      provider: provider.kind,
      bucket: provider.bucket,
      key,
      originalName: fileName,
      mimeType,
      size: totalSize,
      checksum: '', // Will be updated on completion
      status: FileStatus.UPLOADING,
      storageClass: StorageClass.STANDARD,
      access: FileAccess.PRIVATE,
      metadata: metadata || {},
      tags: [],
      currentVersionId: '', // Will be created on completion
      createdById: userId,
      accessCount: 0,
    });

    await this.fileRepo.save(file);

    return { uploadId, fileId, uploadUrls };
  }

  async completeMultipartUpload(
    uploadId: string,
    partETags: string[],
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const multipartUpload = await this.multipartRepo.findOne({
      where: { uploadId },
    });
    if (!multipartUpload) {
      throw new NotFoundException('Multipart upload not found');
    }

    const file = await this.fileRepo.findOne({
      where: { id: multipartUpload.fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');
    const userId = actor.id;
    const provider = this.drivers.forFile(file.provider);
    const complete = this.drivers.require(provider, 'completeMultipartUpload');

    const parts = partETags.map((etag, index) => ({
      partNumber: index + 1,
      etag,
    }));

    await complete(uploadId, file.key, parts);

    // Update file status
    const versionId = randomUUID();
    file.status = FileStatus.ACTIVE;
    file.currentVersionId = versionId;

    // Create version
    const version = this.versionRepo.create({
      id: versionId,
      fileId: file.id,
      versionNumber: 1,
      size: file.size,
      checksum: '', // Could calculate from parts
      key: file.key,
      createdById: userId,
      isCurrent: true,
      changeDescription: 'Multipart upload',
    });

    await this.versionRepo.save(version);
    await this.fileRepo.save(file);

    // Delete multipart upload record
    await this.multipartRepo.delete(multipartUpload.id);

    return file;
  }

  // ==================== FILE MANAGEMENT ====================

  async moveFile(
    fileId: string,
    destinationFolder: string,
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');

    file.folder = destinationFolder;
    file.updatedAt = new Date();

    return this.fileRepo.save(file);
  }

  async copyFile(
    fileId: string,
    destinationFolder: string,
    newName: string | undefined,
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const sourceFile = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!sourceFile) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(sourceFile, actor, 'read');
    const userId = actor.id;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const newFileId = randomUUID();
      const versionId = randomUUID();
      const fileName = newName || sourceFile.originalName;
      const key = this.generateKey(tenantId, newFileId, 1, fileName);

      // Copy in storage — within the store the source lives in.
      const provider = this.drivers.forFile(sourceFile.provider);
      this.assertTenantKey(tenantId, sourceFile.key);
      this.assertTenantKey(tenantId, key);
      await provider.copy(sourceFile.key, key);

      // Create new file record
      const newFile = queryRunner.manager.create(StorageFile, {
        id: newFileId,
        tenantId,
        provider: sourceFile.provider,
        bucket: sourceFile.bucket,
        key,
        originalName: fileName,
        mimeType: sourceFile.mimeType,
        size: sourceFile.size,
        checksum: sourceFile.checksum,
        status: FileStatus.ACTIVE,
        storageClass: sourceFile.storageClass,
        access: sourceFile.access,
        metadata: { ...sourceFile.metadata, copiedFrom: fileId },
        tags: [...sourceFile.tags],
        currentVersionId: versionId,
        createdById: userId,
        folder: destinationFolder,
        accessCount: 0,
      });

      const version = queryRunner.manager.create(FileVersion, {
        id: versionId,
        fileId: newFileId,
        versionNumber: 1,
        size: sourceFile.size,
        checksum: sourceFile.checksum,
        key,
        createdById: userId,
        isCurrent: true,
        changeDescription: `Copied from ${sourceFile.originalName}`,
      });

      await queryRunner.manager.save(newFile);
      await queryRunner.manager.save(version);

      await queryRunner.commitTransaction();

      return newFile;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteFile(
    fileId: string,
    tenantId: string,
    actor: Actor,
    permanent: boolean = false,
  ): Promise<void> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'delete');

    if (permanent) {
      // Delete from storage
      const provider = this.drivers.forFile(file.provider);
      this.assertTenantKey(tenantId, file.key);
      await provider.delete(file.key);

      // Delete versions
      const versions = await this.versionRepo.find({ where: { fileId } });
      for (const version of versions) {
        if (version.key !== file.key) {
          this.assertTenantKey(tenantId, version.key);
          await provider.delete(version.key);
        }
      }

      // Delete records
      await this.versionRepo.delete({ fileId });
      await this.fileRepo.delete(fileId);
    } else {
      // Soft delete
      file.status = FileStatus.DELETED;
      file.deletedAt = new Date();
      await this.fileRepo.save(file);
    }
  }

  async restoreFile(
    fileId: string,
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
      withDeleted: true,
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');

    file.status = FileStatus.ACTIVE;
    file.deletedAt = null;

    return this.fileRepo.save(file);
  }

  // ==================== SEARCH & QUERY ====================

  async searchFiles(
    filters: FileSearchFilters,
  ): Promise<{ files: StorageFile[]; total: number }> {
    const queryBuilder = this.fileRepo.createQueryBuilder('file');

    queryBuilder.where('file.tenantId = :tenantId', {
      tenantId: filters.tenantId,
    });
    queryBuilder.andWhere('file.status != :deletedStatus', {
      deletedStatus: FileStatus.DELETED,
    });

    if (filters.query) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('file.originalName ILIKE :query', {
            query: `%${filters.query}%`,
          }).orWhere('file.metadata::text ILIKE :query');
        }),
      );
    }

    if (filters.mimeTypes?.length) {
      queryBuilder.andWhere('file.mimeType IN (:...mimeTypes)', {
        mimeTypes: filters.mimeTypes,
      });
    }

    if (filters.tags?.length) {
      queryBuilder.andWhere('file.tags @> :tags', { tags: filters.tags });
    }

    if (filters.folder) {
      queryBuilder.andWhere('file.folder = :folder', {
        folder: filters.folder,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('file.status = :status', {
        status: filters.status,
      });
    }

    if (filters.storageClass) {
      queryBuilder.andWhere('file.storageClass = :storageClass', {
        storageClass: filters.storageClass,
      });
    }

    if (filters.createdAfter) {
      queryBuilder.andWhere('file.createdAt >= :createdAfter', {
        createdAfter: filters.createdAfter,
      });
    }

    if (filters.createdBefore) {
      queryBuilder.andWhere('file.createdAt <= :createdBefore', {
        createdBefore: filters.createdBefore,
      });
    }

    if (filters.sizeMin !== undefined) {
      queryBuilder.andWhere('file.size >= :sizeMin', {
        sizeMin: filters.sizeMin,
      });
    }

    if (filters.sizeMax !== undefined) {
      queryBuilder.andWhere('file.size <= :sizeMax', {
        sizeMax: filters.sizeMax,
      });
    }

    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder?.toUpperCase() || 'DESC';
    queryBuilder.orderBy(`file.${sortBy}`, sortOrder as 'ASC' | 'DESC');

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    queryBuilder.skip((page - 1) * limit).take(limit);

    const [files, total] = await queryBuilder.getManyAndCount();

    return { files, total };
  }

  async getFile(
    fileId: string,
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
      relations: ['versions'],
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'read');

    return file;
  }

  async getVersions(
    fileId: string,
    tenantId: string,
    actor: Actor,
  ): Promise<FileVersion[]> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'read');

    return this.versionRepo.find({
      where: { fileId },
      order: { versionNumber: 'DESC' },
    });
  }

  // ==================== STORAGE MANAGEMENT ====================

  async updateFile(
    fileId: string,
    updates: {
      metadata?: Record<string, any>;
      tags?: string[];
      storageClass?: StorageClass;
      access?: FileAccess;
      status?: string;
    },
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');

    if (updates.metadata !== undefined) file.metadata = updates.metadata;
    if (updates.tags !== undefined) file.tags = updates.tags;
    if (updates.access !== undefined) file.access = updates.access;
    if (updates.status !== undefined)
      file.status = updates.status as FileStatus;

    if (updates.storageClass && updates.storageClass !== file.storageClass) {
      const provider = this.drivers.forFile(file.provider);
      const change = this.drivers.require(provider, 'changeStorageClass');
      this.assertTenantKey(tenantId, file.key);
      await change(file.key, updates.storageClass);
      file.storageClass = updates.storageClass;
    }

    file.updatedAt = new Date();
    return this.fileRepo.save(file);
  }

  async changeStorageClass(
    fileId: string,
    storageClass: StorageClass,
    tenantId: string,
    actor: Actor,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, actor, 'write');

    // Storage classes are an S3 concept. Supabase has one tier, and a 501
    // here is the truthful answer; "changed" with nothing changed is not.
    const provider = this.drivers.forFile(file.provider);
    const change = this.drivers.require(provider, 'changeStorageClass');
    this.assertTenantKey(tenantId, file.key);
    await change(file.key, storageClass);

    file.storageClass = storageClass;
    file.updatedAt = new Date();

    return this.fileRepo.save(file);
  }

  async getMetrics(tenantId: string): Promise<StorageMetrics> {
    const totalFiles = await this.fileRepo.count({ where: { tenantId } });

    const totalSizeResult = await this.fileRepo
      .createQueryBuilder('file')
      .select('SUM(file.size)', 'total')
      .where('file.tenantId = :tenantId', { tenantId })
      .getRawOne();

    const storageByClass: Record<
      StorageClass,
      { count: number; size: number }
    > = {
      [StorageClass.STANDARD]: { count: 0, size: 0 },
      [StorageClass.INFREQUENT]: { count: 0, size: 0 },
      [StorageClass.ARCHIVE]: { count: 0, size: 0 },
      [StorageClass.GLACIER]: { count: 0, size: 0 },
    };

    const byClassResults = await this.fileRepo
      .createQueryBuilder('file')
      .select('file.storageClass', 'class')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(file.size)', 'size')
      .where('file.tenantId = :tenantId', { tenantId })
      .groupBy('file.storageClass')
      .getRawMany();

    for (const result of byClassResults) {
      if (storageByClass[result.class]) {
        storageByClass[result.class] = {
          count: parseInt(result.count),
          size: parseInt(result.size),
        };
      }
    }

    // Access patterns (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const accessPatterns = await this.fileRepo
      .createQueryBuilder('file')
      .select('DATE(file.lastAccessedAt)', 'date')
      .addSelect('SUM(file.accessCount)', 'downloads')
      .where('file.tenantId = :tenantId', { tenantId })
      .andWhere('file.lastAccessedAt >= :thirtyDaysAgo', { thirtyDaysAgo })
      .groupBy('DATE(file.lastAccessedAt)')
      .orderBy('date', 'ASC')
      .getRawMany();

    return {
      totalFiles,
      totalSize: parseInt(totalSizeResult?.total || 0),
      storageByClass,
      accessPatterns: accessPatterns.map((a) => ({
        date: a.date,
        downloads: parseInt(a.downloads) || 0,
        uploads: 0, // Would need separate tracking
      })),
    };
  }

  // ==================== PRIVATE HELPERS ====================

  private generateKey(
    tenantId: string,
    fileId: string,
    version: number,
    fileName: string,
  ): string {
    const ext = path.extname(fileName);
    return `tenants/${tenantId}/files/${fileId}/v${version}${ext}`;
  }

  private calculateChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Every key this service hands a driver lives under the caller's tenant.
   *
   * This is the load-bearing check for Supabase, whose service-role key
   * bypasses Supabase's own row-level security entirely: nothing on that side
   * knows what a tenant is. RLS on `storage_files` stops one tenant *finding*
   * another's row, but a key is a string, and a row whose key pointed outside
   * its tenant's prefix — by a bug, a bad migration, or a hand-edited row —
   * would be served without this. Asserted on every read, write, copy and
   * delete, not just on key generation.
   */
  private assertTenantKey(tenantId: string, key: string): void {
    const prefix = `tenants/${tenantId}/`;
    if (!key || !key.startsWith(prefix) || key.includes('..')) {
      this.logger.error(
        `Refusing storage access: key "${key}" is outside tenant ${tenantId}`,
      );
      throw new ForbiddenException('Storage key is outside the caller tenant');
    }
  }

  /** Signed URLs are short-lived: never more than 15 minutes, default 5. */
  private clampTtl(seconds?: number): number {
    const max = 15 * 60;
    const def = 5 * 60;
    if (!seconds || seconds <= 0) return def;
    return Math.min(seconds, max);
  }

  /**
   * Who may touch a storage file, decided by the same `Actor`/`scopeOf` model
   * as documents (`DocumentAccessService`), so the two paths give ONE answer.
   *
   * This used to deny anyone who was not the uploader — the mirror image of
   * the documents stub that allowed everyone — so a caseworker could not open
   * a file a client had uploaded, while `@CurrentUser('sub')` in the
   * controller resolved to `undefined` (the payload field is `id`), which made
   * the "owner" comparison `undefined === undefined` for files whose
   * `createdById` was never set. Two wrong answers on one route.
   *
   * | Caller                     | read                      | write / delete |
   * |----------------------------|---------------------------|----------------|
   * | inside `runAsGod`          | yes                       | yes            |
   * | `firm_admin` / `staff`     | yes                       | yes            |
   * | owner (`createdById`)      | yes                       | yes            |
   * | anyone else in the tenant  | only if `access: public`  | no             |
   *
   * A file the caller cannot read is a **404, not a 403**: ids travel in
   * links, and "real but not yours" is itself a disclosure.
   */
  private async checkAccess(
    file: StorageFile,
    actor: Actor,
    action: 'read' | 'write' | 'delete',
  ): Promise<void> {
    const scope = scopeOf(actor);
    if (scope === 'god' || scope === 'tenant') return;

    if (file.createdById && file.createdById === actor.id) return;

    const publicRead = file.access === FileAccess.PUBLIC;
    if (publicRead && action === 'read') return;

    if (!publicRead) {
      throw new NotFoundException('File not found');
    }
    throw new ForbiddenException(
      `Access denied: insufficient permissions to ${action} file`,
    );
  }
}
