import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
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
} from './interfaces/storage.interface';
import { S3StorageProvider } from './providers/s3.provider';
import * as crypto from 'crypto';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Provider: S3StorageProvider;
  private readonly defaultProvider: StorageProvider;

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
  ) {
    this.s3Provider = new S3StorageProvider(configService);
    this.defaultProvider = this.configService.get<StorageProvider>(
      'storage.defaultProvider',
      StorageProvider.S3,
    );
  }

  // ==================== UPLOAD OPERATIONS ====================

  async upload(options: UploadOptions): Promise<StorageFile> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const fileId = uuidv4();
      const versionId = uuidv4();
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
      const provider = this.getProviderInstance(options.tenantId);
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
        provider: this.defaultProvider,
        bucket: this.configService.get('AWS_S3_BUCKET', 'meru-storage'),
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
    userId: string,
  ): Promise<FileVersion> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

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
      const versionId = uuidv4();

      // Generate key for new version
      const key = this.generateKey(
        tenantId,
        fileId,
        versionNumber,
        file.originalName,
      );
      const checksum = this.calculateChecksum(buffer);

      // Upload to storage
      const provider = this.getProviderInstance(tenantId);
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
    userId: string,
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

    await this.checkAccess(file, userId, 'read');

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

    const provider = this.getProviderInstance(tenantId);
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
    options: PresignedUrlOptions & { tenantId: string; userId?: string },
  ): Promise<string> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId: options.tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (options.userId) {
      await this.checkAccess(file, options.userId, 'read');
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

    const provider = this.getProviderInstance(options.tenantId);
    return provider.getPresignedUrl(version.key, options);
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
    const fileId = uuidv4();
    const key = this.generateKey(tenantId, fileId, 1, fileName);

    const provider = this.getProviderInstance(tenantId);
    const uploadId = await provider.initiateMultipartUpload(key, {
      contentType: mimeType,
      metadata,
    });

    const totalParts = Math.ceil(totalSize / partSize);
    const uploadUrls: { partNumber: number; url: string }[] = [];

    for (let i = 1; i <= totalParts; i++) {
      const url = await provider.getPresignedUrlForPart(uploadId, key, i, 3600);
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
      provider: this.defaultProvider,
      bucket: this.configService.get('AWS_S3_BUCKET', 'meru-storage'),
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
    userId: string,
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

    const provider = this.getProviderInstance(tenantId);

    const parts = partETags.map((etag, index) => ({
      partNumber: index + 1,
      etag,
    }));

    await provider.completeMultipartUpload(uploadId, file.key, parts);

    // Update file status
    const versionId = uuidv4();
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
    userId: string,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'write');

    file.folder = destinationFolder;
    file.updatedAt = new Date();

    return this.fileRepo.save(file);
  }

  async copyFile(
    fileId: string,
    destinationFolder: string,
    newName: string | undefined,
    tenantId: string,
    userId: string,
  ): Promise<StorageFile> {
    const sourceFile = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!sourceFile) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(sourceFile, userId, 'read');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const newFileId = uuidv4();
      const versionId = uuidv4();
      const fileName = newName || sourceFile.originalName;
      const key = this.generateKey(tenantId, newFileId, 1, fileName);

      // Copy in storage
      const provider = this.getProviderInstance(tenantId);
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
    userId: string,
    permanent: boolean = false,
  ): Promise<void> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'delete');

    if (permanent) {
      // Delete from storage
      const provider = this.getProviderInstance(tenantId);
      await provider.delete(file.key);

      // Delete versions
      const versions = await this.versionRepo.find({ where: { fileId } });
      for (const version of versions) {
        if (version.key !== file.key) {
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
    userId: string,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
      withDeleted: true,
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'write');

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
    userId: string,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
      relations: ['versions'],
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'read');

    return file;
  }

  async getVersions(
    fileId: string,
    tenantId: string,
    userId: string,
  ): Promise<FileVersion[]> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'read');

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
    userId: string,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'write');

    if (updates.metadata !== undefined) file.metadata = updates.metadata;
    if (updates.tags !== undefined) file.tags = updates.tags;
    if (updates.access !== undefined) file.access = updates.access;
    if (updates.status !== undefined)
      file.status = updates.status as FileStatus;

    if (updates.storageClass && updates.storageClass !== file.storageClass) {
      const provider = this.getProviderInstance(tenantId);
      await provider.changeStorageClass(file.key, updates.storageClass);
      file.storageClass = updates.storageClass;
    }

    file.updatedAt = new Date();
    return this.fileRepo.save(file);
  }

  async changeStorageClass(
    fileId: string,
    storageClass: StorageClass,
    tenantId: string,
    userId: string,
  ): Promise<StorageFile> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, tenantId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.checkAccess(file, userId, 'write');

    const provider = this.getProviderInstance(tenantId);
    await provider.changeStorageClass(file.key, storageClass);

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

  private getProviderInstance(tenantId: string): S3StorageProvider {
    // For now, always use S3. Could be extended to support per-tenant providers
    return this.s3Provider;
  }

  private async checkAccess(
    file: StorageFile,
    userId: string,
    action: 'read' | 'write' | 'delete',
  ): Promise<void> {
    // Owner has full access
    if (file.createdById === userId) {
      return;
    }

    // Check file access level
    if (file.access === FileAccess.PUBLIC && action === 'read') {
      return;
    }

    // TODO: Implement more sophisticated RBAC
    // For now, deny access if not owner
    throw new ForbiddenException(
      `Access denied: insufficient permissions to ${action} file`,
    );
  }
}
