import { Module } from '@nestjs/common';
import { IamModule } from './iam.module';
import { TenantModule } from '../tenant/tenant.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DocumentsModule } from '../documents/documents.module';
import { OperatorController } from './operator.controller';
import { PlatformDocumentsController } from './platform-documents.controller';

/**
 * The God UI's per-tenant operator routes.
 *
 * A separate module because the controllers need BrandingService
 * (TenantModule), ConnectorsService (IntegrationsModule) and, as of ADR 0009
 * §2.3, DocumentAccessService (DocumentsModule) alongside IAM's own services
 * — and IntegrationsModule and DocumentsModule both already import IamModule,
 * so hanging either off an IAM controller would make that a cycle. Nothing
 * imports OperatorModule in turn, so the graph stays acyclic:
 *
 *   OperatorModule → { IamModule, TenantModule, IntegrationsModule, DocumentsModule }
 *   IntegrationsModule → IamModule
 *   DocumentsModule → IamModule
 *
 * `PlatformDocumentsController` (`platform-documents.controller.ts`) lives
 * here rather than on `IamModule`'s `PlatformController` for exactly this
 * reason — see that file's header comment for the full account.
 */
@Module({
  imports: [IamModule, TenantModule, IntegrationsModule, DocumentsModule],
  controllers: [OperatorController, PlatformDocumentsController],
})
export class OperatorModule {}
