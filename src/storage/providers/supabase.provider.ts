import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  ObjectStorageDriver,
  PresignedUrlOptions,
  StorageProvider,
} from '../interfaces/storage.interface';

/**
 * Supabase Storage as an object store.
 *
 * THE SECURITY MODEL, in one paragraph (CLAUDE.md §5.1b): this driver holds
 * the **service-role key**, and the service-role key BYPASSES Supabase's own
 * row-level security on `storage.objects`. Supabase therefore enforces
 * nothing between tenants. The ONLY isolation barrier is the app's own
 * `tenants/<tenantId>/` key prefix, asserted in `StorageService` before every
 * call reaches this class. This driver must never be handed a key that has
 * not passed that assertion, and nothing here may construct one.
 *
 * Consequences that are deliberate:
 *  - The bucket is PRIVATE. `getPublicUrl` is never called; a public bucket
 *    would make every document on the platform readable by URL.
 *  - Reads are served through short-TTL **server-signed** URLs
 *    (`createSignedUrl`). The default TTL is capped in `getPresignedUrl`.
 *  - The anon key is never used. There is no browser-side path to storage.
 *
 * Optional interface members — multipart and storage classes — are NOT
 * implemented. Supabase Storage has no equivalent, and `StorageService`
 * reports those operations as unsupported for this provider rather than
 * pretending. `getUploadPresignedUrl` IS implemented, because Supabase has a
 * genuine equivalent (`createSignedUploadUrl`).
 *
 * Supabase returns no content ETag from `upload`, so `etag` is the MD5 of
 * the bytes this process sent — the same value S3 would compute for a
 * single-part PUT, and what `StorageService` stores as the checksum anyway.
 */
@Injectable()
export class SupabaseStorageProvider implements ObjectStorageDriver {
  private readonly logger = new Logger(SupabaseStorageProvider.name);
  readonly kind = StorageProvider.SUPABASE;
  readonly bucket: string;
  /** True only when URL and service key are both present. */
  readonly configured: boolean;
  private readonly client: SupabaseClient | null;

  /** Longest read URL this driver will sign, whatever the caller asks for. */
  static readonly MAX_SIGNED_READ_TTL_SECONDS = 15 * 60;
  static readonly DEFAULT_SIGNED_READ_TTL_SECONDS = 5 * 60;

  /**
   * Injection token for a pre-built client. Nothing provides it in the
   * module — it exists so the spec can hand in a mock, and so Nest does not
   * try to resolve `SupabaseClient` (a class it knows nothing about) as a
   * dependency. Without `@Optional()` + an explicit token this constructor
   * failed DI at boot, which on Vercel prints the route table and then dies.
   */
  static readonly CLIENT = Symbol('SUPABASE_STORAGE_CLIENT');

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(SupabaseStorageProvider.CLIENT)
    client?: SupabaseClient,
  ) {
    const url = this.config.get<string>('SUPABASE_URL')?.trim();
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    this.bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET', 'meru-documents');

    if (client) {
      this.client = client;
      this.configured = true;
    } else if (url && serviceKey) {
      this.client = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      this.configured = true;
    } else {
      this.client = null;
      this.configured = false;
    }
  }

  private get files() {
    if (!this.client) {
      // Unreachable when the registry only registers configured drivers; kept
      // as a guard so a misregistration is a clear error, not a null deref.
      throw new BadRequestException(
        'Supabase storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
      );
    }
    return this.client.storage.from(this.bucket);
  }

  private fail(op: string, error: { message?: string } | null): never {
    const message = error?.message ?? 'unknown error';
    this.logger.error(`Supabase ${op} failed: ${message}`);
    if (/not found|does not exist/i.test(message)) {
      throw new NotFoundException(`Object not found`);
    }
    throw new BadRequestException(`${op} failed: ${message}`);
  }

  async upload(
    buffer: Buffer,
    key: string,
    options: {
      contentType?: string;
      metadata?: Record<string, any>;
      encrypt?: boolean;
    } = {},
  ): Promise<{ etag: string; versionId?: string }> {
    // `encrypt` is ignored: Supabase encrypts at rest unconditionally and
    // offers no per-object toggle. `StorageService` handles app-level
    // encryption above the driver when a file demands it.
    const { error } = await this.files.upload(key, buffer, {
      contentType: options.contentType,
      upsert: false,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    if (error) this.fail('upload', error);

    return { etag: crypto.createHash('md5').update(buffer).digest('hex') };
  }

  async download(key: string): Promise<Buffer> {
    const { data, error } = await this.files.download(key);
    if (error || !data) this.fail('download', error);
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.files.remove([key]);
    if (error) this.fail('delete', error);
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const { error } = await this.files.copy(sourceKey, destinationKey);
    if (error) this.fail('copy', error);
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    const { error } = await this.files.move(sourceKey, destinationKey);
    if (error) this.fail('move', error);
  }

  /**
   * A short-lived server-signed read URL. Never public. The TTL is clamped
   * so a caller cannot ask for a day-long link to a private document.
   */
  async getPresignedUrl(key: string, options: PresignedUrlOptions): Promise<string> {
    const requested =
      options.expiresInSeconds ?? SupabaseStorageProvider.DEFAULT_SIGNED_READ_TTL_SECONDS;
    const ttl = Math.max(
      1,
      Math.min(requested, SupabaseStorageProvider.MAX_SIGNED_READ_TTL_SECONDS),
    );

    const { data, error } = await this.files.createSignedUrl(key, ttl, {
      // `download: <filename>` sets Content-Disposition: attachment.
      download:
        options.responseDisposition === 'attachment' ? path.basename(key) : undefined,
    });
    if (error || !data?.signedUrl) this.fail('createSignedUrl', error);
    return data.signedUrl;
  }

  /** Supabase's genuine equivalent of a presigned PUT. Single object only. */
  async getUploadPresignedUrl(key: string, expiresIn = 300): Promise<string> {
    // Supabase fixes the upload-URL lifetime server-side (2h); `expiresIn`
    // cannot shorten it and is accepted only for interface compatibility.
    void expiresIn;
    const { data, error } = await this.files.createSignedUploadUrl(key);
    if (error || !data?.signedUrl) this.fail('createSignedUploadUrl', error);
    return data.signedUrl;
  }

  async getObjectMetadata(key: string): Promise<{
    size: number;
    lastModified: Date;
    etag: string;
    storageClass: string;
    metadata: Record<string, any>;
  }> {
    const { data, error } = await this.files.info(key);
    if (error || !data) this.fail('info', error);
    return {
      size: Number(data.size ?? 0),
      lastModified: new Date(data.lastModified ?? data.createdAt ?? Date.now()),
      etag: (data.etag ?? '').replace(/"/g, ''),
      // Supabase has exactly one storage class. Reported as such, not mapped
      // onto an S3 name it does not have.
      storageClass: 'supabase',
      metadata: (data.metadata as Record<string, any>) ?? {},
    };
  }

  async listObjects(
    prefix: string,
    maxKeys = 1000,
  ): Promise<{ key: string; size: number; lastModified: Date; etag: string }[]> {
    // Supabase lists one "folder" level at a time and returns folders as
    // entries with no `id`. Only real objects are returned here; a caller
    // that wants a recursive listing walks prefixes itself.
    const folder = prefix.replace(/\/+$/, '');
    const { data, error } = await this.files.list(folder, {
      limit: maxKeys,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) this.fail('list', error);

    return (data ?? [])
      .filter((o) => !!o.id)
      .map((o) => ({
        key: folder ? `${folder}/${o.name}` : o.name,
        size: Number(o.metadata?.size ?? 0),
        lastModified: new Date(o.updated_at ?? o.created_at ?? Date.now()),
        etag: String(o.metadata?.eTag ?? '').replace(/"/g, ''),
      }));
  }
}
