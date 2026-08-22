// Storage driver layer — object-store abstraction.
//
// Public surface: StorageService (upload, download, presigned URLs, lifecycle).
// Drivers live under providers/: S3 and Supabase Storage. All file I/O across
// the platform goes through this module; DocumentsService is the primary
// consumer and no longer constructs an S3 client of its own.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import {
  StorageFile,
  FileVersion,
  MultipartUpload,
} from './entities/storage-file.entity';
import { S3StorageProvider } from './providers/s3.provider';
import { SupabaseStorageProvider } from './providers/supabase.provider';
import { StorageDriverRegistry } from './storage-driver.registry';
import { STORAGE_DRIVERS } from './interfaces/storage.interface';
import { Tenant } from '../iam/entities/tenant.entity';
import { IamModule } from '../iam/iam.module';

@Module({
  imports: [
    // Tenant is read-only here: the registry resolves a tenant's configured
    // provider. Consumers never write tenants through this module.
    TypeOrmModule.forFeature([StorageFile, FileVersion, MultipartUpload, Tenant]),
    IamModule,
  ],
  providers: [
    StorageService,
    S3StorageProvider,
    SupabaseStorageProvider,
    // Every object-storage driver registers here under its `kind`. The registry
    // picks per file (`file.provider`) and per tenant (`tenants.settings`), with
    // STORAGE_PROVIDER as the platform default. Add a driver = add it to this
    // array; nothing else in the module changes.
    //
    // Only drivers that HAVE credentials are registered. An uncredentialed S3
    // driver used to register anyway, which made it the silent default and
    // produced `timeout exceeded when trying to connect` 500s on upload. With
    // exactly one credentialed driver the registry selects it without
    // STORAGE_PROVIDER; with two, STORAGE_PROVIDER must choose.
    {
      provide: STORAGE_DRIVERS,
      useFactory: (s3: S3StorageProvider, supabase: SupabaseStorageProvider) =>
        [s3, supabase].filter((d) => d.configured),
      inject: [S3StorageProvider, SupabaseStorageProvider],
    },
    // Injected by StorageService. Must stay listed: a provider that is imported
    // and injected but never registered fails at DI time, which on Vercel
    // prints a full route table and THEN dies on every route.
    StorageDriverRegistry,
  ],
  controllers: [StorageController],
  exports: [StorageService, StorageDriverRegistry],
})
export class StorageModule {}
