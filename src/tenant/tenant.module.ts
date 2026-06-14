import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantSetting } from './entities/tenant-setting.entity';
import { ConfigPack } from './entities/config-pack.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { TenantConfigPin } from '../iam/entities/tenant-config-pin.entity';
import { TenantSettingsService } from './tenant-settings.service';
import { ConfigPackService } from './services/config-pack.service';
import { ConfigPackLoaderService } from './services/config-pack-loader.service';
import { TenantController } from './tenant.controller';
import { ConfigPackController } from './controllers/config-pack.controller';
import { CoreModule } from '../core/core.module';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';

// TCM (Tenant Config Management) — CLAUDE.md §2 row 2.
// Owns: tenant settings, config packs (vertical/country JSON), feature flags,
// and pin records that bind a tenant to a specific pack version.
// App-boot configuration (env vars, DB connection, AWS secrets) lives in src/config/.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantSetting,
      ConfigPack,
      FeatureFlag,
      TenantConfigPin,
    ]),
    CoreModule,
    BillingModule,
    AuditModule,
  ],
  controllers: [TenantController, ConfigPackController],
  providers: [
    TenantSettingsService,
    ConfigPackService,
    ConfigPackLoaderService,
  ],
  exports: [TenantSettingsService, ConfigPackService],
})
export class TenantModule {}
