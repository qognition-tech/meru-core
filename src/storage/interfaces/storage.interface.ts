import { Actor } from '../../common/access';

export enum StorageProvider {
  S3 = 's3',
  AZURE = 'azure',
  GCS = 'gcs',
  LOCAL = 'local',
  SUPABASE = 'supabase',
}

/**
 * The driver contract every object store implements.
 *
 * `StorageService` (and, through it, `DocumentsService`) talks to this and
 * nothing else. A driver knows one bucket and one credential set; it does NOT
 * know about tenants, users or authorisation — the per-tenant key prefix is
 * asserted above it, in `StorageService`, because for Supabase the service key
 * bypasses Supabase's own RLS and the prefix check is the only barrier there is.
 *
 * Methods marked optional are S3 concepts with no Supabase equivalent. A driver
 * that lacks one leaves it undefined and the service reports the operation as
 * unsupported for that provider rather than pretending it happened.
 */
export interface ObjectStorageDriver {
  readonly kind: StorageProvider;
  readonly bucket: string;

  upload(
    buffer: Buffer,
    key: string,
    options?: {
      contentType?: string;
      metadata?: Record<string, any>;
      storageClass?: StorageClass;
      encrypt?: boolean;
    },
  ): Promise<{ etag: string; versionId?: string }>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  move(sourceKey: string, destinationKey: string): Promise<void>;
  /** A short-lived, server-signed read URL. Never a public URL. */
  getPresignedUrl(key: string, options: PresignedUrlOptions): Promise<string>;
  getObjectMetadata(key: string): Promise<{
    size: number;
    lastModified: Date;
    etag: string;
    storageClass: string;
    metadata: Record<string, any>;
  }>;
  listObjects(
    prefix: string,
    maxKeys?: number,
  ): Promise<{ key: string; size: number; lastModified: Date; etag: string }[]>;

  // ── Optional: S3-only concepts ─────────────────────────────────────────
  getUploadPresignedUrl?(key: string, expiresIn?: number): Promise<string>;
  changeStorageClass?(key: string, storageClass: StorageClass): Promise<void>;
  initiateMultipartUpload?(
    key: string,
    options?: { contentType?: string; metadata?: Record<string, any> },
  ): Promise<string>;
  getPresignedUrlForPart?(
    uploadId: string,
    key: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  completeMultipartUpload?(
    uploadId: string,
    key: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipartUpload?(uploadId: string, key: string): Promise<void>;
}

/** Injection token for the drivers `StorageModule` managed to configure. */
export const STORAGE_DRIVERS = Symbol('STORAGE_DRIVERS');

export enum StorageClass {
  STANDARD = 'standard',
  INFREQUENT = 'infrequent',
  ARCHIVE = 'archive',
  GLACIER = 'glacier',
}

export enum FileStatus {
  UPLOADING = 'uploading',
  ACTIVE = 'active',
  PROCESSING = 'processing',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

export enum FileAccess {
  PUBLIC = 'public',
  PRIVATE = 'private',
  RESTRICTED = 'restricted',
}

export interface StorageFile {
  id: string;
  tenantId: string;
  provider: StorageProvider;
  bucket: string;
  key: string;
  originalName: string;
  mimeType: string;
  size: number;
  checksum: string;
  status: FileStatus;
  storageClass: StorageClass;
  access: FileAccess;
  metadata: Record<string, any>;
  tags: string[];
  encryption?: {
    algorithm: string;
    keyId?: string;
  };
  versions: FileVersion[];
  currentVersionId: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  lastAccessedAt?: Date;
  accessCount: number;
}

export interface FileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  size: number;
  checksum: string;
  key: string;
  createdAt: Date;
  createdById: string;
  changeDescription?: string;
  isCurrent: boolean;
}

export interface UploadOptions {
  tenantId: string;
  fileName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  metadata?: Record<string, any>;
  tags?: string[];
  storageClass?: StorageClass;
  access?: FileAccess;
  expiresInDays?: number;
  encrypt?: boolean;
  folder?: string;
  userId: string;
}

export interface DownloadOptions {
  fileId: string;
  versionId?: string;
  tenantId: string;
  userId?: string;
}

export interface StorageProviderConfig {
  provider: StorageProvider;
  region?: string;
  bucket: string;
  credentials: {
    accessKeyId?: string;
    secretAccessKey?: string;
    connectionString?: string;
    projectId?: string;
    keyFilename?: string;
  };
  options?: {
    endpoint?: string;
    forcePathStyle?: boolean;
    sslEnabled?: boolean;
  };
}

export interface PresignedUrlOptions {
  fileId: string;
  versionId?: string;
  expiresInSeconds?: number;
  responseDisposition?: 'inline' | 'attachment';
  responseContentType?: string;
}

export interface MultipartUpload {
  uploadId: string;
  fileId: string;
  parts: MultipartPart[];
  partSize: number;
  totalParts: number;
  completedParts: number;
  status: 'pending' | 'in_progress' | 'completed' | 'aborted';
  createdAt: Date;
  expiresAt: Date;
}

export interface MultipartPart {
  partNumber: number;
  etag?: string;
  size: number;
  status: 'pending' | 'uploaded';
}

export interface StorageMetrics {
  totalFiles: number;
  totalSize: number;
  storageByClass: Record<StorageClass, { count: number; size: number }>;
  accessPatterns: {
    date: string;
    downloads: number;
    uploads: number;
  }[];
}

export interface FileSearchFilters {
  tenantId: string;
  /**
   * Required, not optional, deliberately. `GET /storage/files` reached
   * `StorageService.searchFiles` with no actor at all and no narrowing beyond
   * `tenantId` — the by-id routes all call `checkAccess()` (owner or tenant
   * staff only), but the LIST path was missed, so any authenticated caller of
   * any role could enumerate every filename, folder, tag and mimeType in the
   * firm. Filenames alone are sensitive here (`passport_<name>.pdf`).
   * `StorageService.searchFiles` uses this the same way `checkAccess` does —
   * see that method's own doc comment.
   */
  actor: Actor;
  query?: string;
  mimeTypes?: string[];
  tags?: string[];
  status?: FileStatus;
  storageClass?: StorageClass;
  createdAfter?: Date;
  createdBefore?: Date;
  sizeMin?: number;
  sizeMax?: number;
  metadata?: Record<string, any>;
  folder?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'size' | 'createdAt' | 'lastAccessedAt';
  sortOrder?: 'asc' | 'desc';
}
