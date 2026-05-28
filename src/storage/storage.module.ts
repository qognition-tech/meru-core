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

@Module({
  imports: [
    TypeOrmModule.forFeature([StorageFile, FileVersion, MultipartUpload]),
  ],
  providers: [StorageService, S3StorageProvider],
  controllers: [StorageController],
  exports: [StorageService],
})
export class StorageModule {}
