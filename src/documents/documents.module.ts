// DOC module per CLAUDE.md §2 row 10.
//
// Layer contract:
//   - documents/ = BUSINESS layer: Document, DocumentVersion, DocumentMetadata
//     entities; OCR, versioning, citations, fraud-detection hooks.
//   - storage/   = DRIVER layer: object-store abstraction (S3, Supabase).
//
// documents.service.ts goes through StorageService for every byte — no
// object-store SDK is imported outside src/storage/. That is what makes the
// tenant-prefix assertion in StorageService the single barrier it has to be.
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentAccessService } from './document-access.service';
import { DocumentHubService } from './document-hub.service';
import { Document } from './entities/document.entity';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { DocumentChecklistService } from './document-checklist.service';
import { DocumentGenerationService } from './document-generation.service';
import { DocumentVersion } from './entities/document-version.entity';
import { DocumentMetadata } from './entities/document-metadata.entity';
import { User } from '../iam/entities/user.entity';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { StorageModule } from '../storage/storage.module';
import { IamModule } from '../iam/iam.module';
import { SearchModule } from '../search/search.module';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Payment } from '../billing/entities/payment.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { RuleEvaluatorModule } from '../rules/rule-evaluator.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Document,
      DocumentVersion,
      DocumentMetadata,
      User,
      // Read-only, for the document-generation render context: a generated
      // cost agreement names the client and totals their payments.
      UniversalEntity,
      Payment,
      Tenant,
    ]),
    // Layer 4 reads (the document checklist) go through the shared resolver.
    VerticalPackModule,
    MulterModule.registerAsync({
      imports: [ConfigModule],
      // memoryStorage, not `dest`. Two reasons, either one sufficient:
      //  1. `dest` makes multer mkdir the directory at module-init time. The
      //     serverless filesystem is read-only outside /tmp, so bootstrap died
      //     with ENOENT on './uploads' before a single route was registered.
      //  2. DocumentsService reads `file.buffer` (documents.service.ts:91),
      //     which diskStorage never populates — it sets `file.path` instead.
      //     Uploads could not have worked on disk storage anyway.
      // Bounded by MAX_FILE_SIZE; contents go straight to S3, never to disk.
      useFactory: async (configService: ConfigService) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: configService.get('MAX_FILE_SIZE', 50 * 1024 * 1024),
        },
      }),
      inject: [ConfigService],
    }),
    forwardRef(() => OrchestrationModule),
    forwardRef(() => AiModule),
    StorageModule,
    IamModule,
    SearchModule,
    AuditModule,
    // The checklist's `appliesWhen` conditions are JsonLogic, evaluated by the
    // same service that backs `rules[]` and `alertRules[]`.
    //
    // `RuleEvaluatorModule`, not `RulesModule`: the latter provides the alert
    // sweep and does not export the evaluator, and importing it would drag
    // NotificationsModule and TasksModule in behind one JSON predicate — the
    // import cycle its own header warns about.
    RuleEvaluatorModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    // Per-user document authorisation. RLS scopes documents to the tenant but
    // NOT to a user within it (CLAUDE.md §5.1), so this is the only thing
    // standing between one client and another client's passport. It is
    // injected by DocumentsService and must stay registered here: a provider
    // that is imported and injected but never listed fails at DI time, which
    // on Vercel prints a full route table and *then* dies with
    // FUNCTION_INVOCATION_FAILED on every route.
    DocumentAccessService,
    DocumentHubService,
    DocumentChecklistService,
    DocumentGenerationService,
  ],
  exports: [
    DocumentsService,
    DocumentHubService,
    DocumentGenerationService,
    // Exported so the document hub and any future consumer share one
    // authorisation decision rather than re-deriving it.
    DocumentAccessService,
  ],
})
export class DocumentsModule {}
