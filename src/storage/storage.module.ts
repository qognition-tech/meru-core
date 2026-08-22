// Storage driver layer — S3/blob abstraction.
//
// Public surface: StorageService (upload, download, presigned URLs, lifecycle).
// Providers live under providers/ — S3StorageProvider today; GCS/Azure later.
// All file I/O across the platform should go through this module.
// Documents module (DOC) is the intended primary consumer; today documents/
// still calls aws-sdk directly — Phase B will rewire it through here.
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
    // Every object-storage driver registers here under its `kind`. The registry
    // picks per file (`file.provider`) and per tenant (`tenants.settings`), with
    // STORAGE_PROVIDER as the platform default. Add a driver = add it to this
    // array; nothing else in the module changes.
    {
      provide: STORAGE_DRIVERS,
      useFactory: (s3: S3StorageProvider) => [s3],
      inject: [S3StorageProvider],
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
