// DOC module per CLAUDE.md §2 row 10.
//
// Layer contract:
//   - documents/ = BUSINESS layer: Document, DocumentVersion, DocumentMetadata
//     entities; OCR, versioning, citations, fraud-detection hooks.
//   - storage/   = DRIVER layer: S3/blob abstraction over multiple providers
//     (S3StorageProvider, future GCS/Azure providers).
//
// TODO(Phase B): documents.service.ts currently uses `aws-sdk` directly
// (see uploadToS3/downloadFile). Refactor to inject StorageService from
// the Storage module — no direct S3 calls outside src/storage/.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentHubService } from './document-hub.service';
import { Document } from './entities/document.entity';
import { DocumentVersion } from './entities/document-version.entity';
import { DocumentMetadata } from './entities/document-metadata.entity';
import { User } from '../iam/entities/user.entity';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { IamModule } from '../iam/iam.module';
import { SearchModule } from '../search/search.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Document,
      DocumentVersion,
      DocumentMetadata,
      User,
    ]),
    MulterModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        dest: './uploads',
        limits: {
          fileSize: configService.get('MAX_FILE_SIZE', 50 * 1024 * 1024),
        },
      }),
      inject: [ConfigService],
    }),
    OrchestrationModule,
    IamModule,
    SearchModule,
    AuditModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentHubService],
  exports: [DocumentsService, DocumentHubService],
})
export class DocumentsModule {}
