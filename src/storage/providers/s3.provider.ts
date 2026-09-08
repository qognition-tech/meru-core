import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3 } from 'aws-sdk';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  StorageProvider,
  StorageClass,
  FileStatus,
  FileAccess,
  UploadOptions,
  DownloadOptions,
  PresignedUrlOptions,
  StorageMetrics,
  FileSearchFilters,
  StorageProviderConfig,
  ObjectStorageDriver,
} from '../interfaces/storage.interface';

@Injectable()
export class S3StorageProvider implements ObjectStorageDriver {
  private readonly logger = new Logger(S3StorageProvider.name);
  private s3: S3;
  // `kind` is how StorageDriverRegistry indexes this driver, and `bucket` is
  // public because the registry and the audit trail both need to name it.
  readonly kind = StorageProvider.S3;
  readonly bucket: string;
  /**
   * True only with a key pair AND an explicit bucket. `StorageModule` registers
   * this driver only when configured; without that, `meru-storage` — a bucket
   * nobody created — was the platform default and every upload hung.
   */
  readonly configured: boolean;

  constructor(private configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.configService
      .get<string>('AWS_SECRET_ACCESS_KEY')
      ?.trim();
    const bucket = this.configService.get<string>('AWS_S3_BUCKET')?.trim();
    this.configured = !!(accessKeyId && secretAccessKey && bucket);
    this.s3 = new S3({
      accessKeyId,
      secretAccessKey,
      region: this.configService.get('AWS_REGION', 'us-east-1'),
    });
    this.bucket = bucket ?? '';
  }

  async upload(
    buffer: Buffer,
    key: string,
    options: {
      contentType?: string;
      metadata?: Record<string, any>;
      storageClass?: StorageClass;
      encrypt?: boolean;
    } = {},
  ): Promise<{ etag: string; versionId?: string }> {
    try {
      const s3StorageClass = this.mapStorageClass(options.storageClass);

      const params: S3.PutObjectRequest = {
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: options.contentType,
        Metadata: options.metadata,
        StorageClass: s3StorageClass,
      };

      if (options.encrypt) {
        params.ServerSideEncryption = 'AES256';
      }

      const result = await this.s3.upload(params).promise();

      return {
        etag: result.ETag?.replace(/"/g, '') || '',
        versionId: (result as any).VersionId,
      };
    } catch (error) {
      this.logger.error(`S3 upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  async download(key: string): Promise<Buffer> {
    try {
      const result = await this.s3
        .getObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();

      return result.Body as Buffer;
    } catch (error) {
      this.logger.error(`S3 download failed: ${error.message}`);
      throw new NotFoundException(`File not found: ${error.message}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3
        .deleteObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();
    } catch (error) {
      this.logger.error(`S3 delete failed: ${error.message}`);
      throw new BadRequestException(`Delete failed: ${error.message}`);
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      await this.s3
        .copyObject({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${sourceKey}`,
          Key: destinationKey,
        })
        .promise();
    } catch (error) {
      this.logger.error(`S3 copy failed: ${error.message}`);
      throw new BadRequestException(`Copy failed: ${error.message}`);
    }
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.copy(sourceKey, destinationKey);
    await this.delete(sourceKey);
  }

  async getPresignedUrl(
    key: string,
    options: PresignedUrlOptions,
  ): Promise<string> {
    const params: any = {
      Bucket: this.bucket,
      Key: key,
      Expires: options.expiresInSeconds || 3600,
    };

    if (options.responseDisposition) {
      params.ResponseContentDisposition =
        options.responseDisposition === 'attachment'
          ? `attachment; filename="${path.basename(key)}"`
          : 'inline';
    }

    if (options.responseContentType) {
      params.ResponseContentType = options.responseContentType;
    }

    return this.s3.getSignedUrlPromise('getObject', params);
  }

  async getUploadPresignedUrl(
    key: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    return this.s3.getSignedUrlPromise('putObject', {
      Bucket: this.bucket,
      Key: key,
      Expires: expiresIn,
    });
  }

  async changeStorageClass(
    key: string,
    storageClass: StorageClass,
  ): Promise<void> {
    try {
      const s3StorageClass = this.mapStorageClass(storageClass);

      await this.s3
        .copyObject({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${key}`,
          Key: key,
          StorageClass: s3StorageClass,
          MetadataDirective: 'COPY',
        })
        .promise();
    } catch (error) {
      this.logger.error(`S3 change storage class failed: ${error.message}`);
      throw new BadRequestException(
        `Storage class change failed: ${error.message}`,
      );
    }
  }

  async initiateMultipartUpload(
    key: string,
    options: {
      contentType?: string;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<string> {
    try {
      const result = await this.s3
        .createMultipartUpload({
          Bucket: this.bucket,
          Key: key,
          ContentType: options.contentType,
          Metadata: options.metadata,
        })
        .promise();

      return result.UploadId!;
    } catch (error) {
      this.logger.error(
        `S3 initiate multipart upload failed: ${error.message}`,
      );
      throw new BadRequestException(
        `Multipart upload initiation failed: ${error.message}`,
      );
    }
  }

  async getPresignedUrlForPart(
    uploadId: string,
    key: string,
    partNumber: number,
    expiresIn: number = 3600,
  ): Promise<string> {
    return this.s3.getSignedUrlPromise('uploadPart', {
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Expires: expiresIn,
    });
  }

  async completeMultipartUpload(
    uploadId: string,
    key: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    try {
      await this.s3
        .completeMultipartUpload({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({
              ETag: p.etag,
              PartNumber: p.partNumber,
            })),
          },
        })
        .promise();
    } catch (error) {
      this.logger.error(
        `S3 complete multipart upload failed: ${error.message}`,
      );
      throw new BadRequestException(
        `Multipart upload completion failed: ${error.message}`,
      );
    }
  }

  async abortMultipartUpload(uploadId: string, key: string): Promise<void> {
    try {
      await this.s3
        .abortMultipartUpload({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        })
        .promise();
    } catch (error) {
      this.logger.error(`S3 abort multipart upload failed: ${error.message}`);
    }
  }

  async getObjectMetadata(key: string): Promise<{
    size: number;
    lastModified: Date;
    etag: string;
    storageClass: string;
    metadata: Record<string, any>;
  }> {
    try {
      const result = await this.s3
        .headObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();

      return {
        size: result.ContentLength || 0,
        lastModified: result.LastModified || new Date(),
        etag: result.ETag?.replace(/"/g, '') || '',
        storageClass: result.StorageClass || 'STANDARD',
        metadata: result.Metadata || {},
      };
    } catch (error) {
      this.logger.error(`S3 get metadata failed: ${error.message}`);
      throw new NotFoundException(`File not found: ${error.message}`);
    }
  }

  async listObjects(
    prefix: string,
    maxKeys: number = 1000,
  ): Promise<
    {
      key: string;
      size: number;
      lastModified: Date;
      etag: string;
    }[]
  > {
    try {
      const result = await this.s3
        .listObjectsV2({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
        })
        .promise();

      return (result.Contents || []).map((obj) => ({
        key: obj.Key || '',
        size: obj.Size || 0,
        lastModified: obj.LastModified || new Date(),
        etag: obj.ETag?.replace(/"/g, '') || '',
      }));
    } catch (error) {
      this.logger.error(`S3 list objects failed: ${error.message}`);
      throw new BadRequestException(`List objects failed: ${error.message}`);
    }
  }

  private mapStorageClass(storageClass?: StorageClass): S3.StorageClass {
    const mapping: Record<StorageClass, S3.StorageClass> = {
      [StorageClass.STANDARD]: 'STANDARD',
      [StorageClass.INFREQUENT]: 'STANDARD_IA',
      [StorageClass.ARCHIVE]: 'GLACIER_IR',
      [StorageClass.GLACIER]: 'DEEP_ARCHIVE',
    };

    return storageClass ? mapping[storageClass] : 'STANDARD';
  }
}
