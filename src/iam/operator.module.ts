import { Module } from '@nestjs/common';
import { IamModule } from './iam.module';
import { TenantModule } from '../tenant/tenant.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OperatorController } from './operator.controller';

/**
 * The God UI's per-tenant operator routes.
 *
 * A separate module because the controller needs BrandingService
 * (TenantModule) and ConnectorsService (IntegrationsModule) alongside IAM's
 * own services — and IntegrationsModule already imports IamModule, so hanging
 * these off an IAM controller would make that a cycle. Nothing imports
 * OperatorModule in turn, so the graph stays acyclic:
 *
 *   OperatorModule → { IamModule, TenantModule, IntegrationsModule }
 *   IntegrationsModule → IamModule
 */
@Module({
  imports: [IamModule, TenantModule, IntegrationsModule],
  controllers: [OperatorController],
})
export class OperatorModule {}
