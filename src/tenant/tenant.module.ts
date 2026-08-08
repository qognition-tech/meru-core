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
import { FeatureFlagController } from './controllers/feature-flag.controller';
import { FeatureFlagService } from './services/feature-flag.service';
import { BrandingController } from './controllers/branding.controller';
import { BrandingService } from './services/branding.service';
import { Tenant } from '../iam/entities/tenant.entity';
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
      Tenant,
    ]),
    CoreModule,
    BillingModule,
    AuditModule,
  ],
  controllers: [
    TenantController,
    ConfigPackController,
    FeatureFlagController,
    BrandingController,
  ],
  providers: [
    TenantSettingsService,
    ConfigPackService,
    ConfigPackLoaderService,
    FeatureFlagService,
    BrandingService,
  ],
  exports: [
    TenantSettingsService,
    ConfigPackService,
    // Exported so `POST /jobs/packs/reload` can run the same load pass as boot
    // and report what it did — see the loader's note on silent failure modes.
    ConfigPackLoaderService,
    FeatureFlagService,
    BrandingService,
  ],
})
export class TenantModule {}
