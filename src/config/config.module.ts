import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { configuration, validationSchema } from './configuration';
import { SupabaseConfigService } from './supabase-config.service';

// App-boot configuration only — env validation, Supabase client, AWS secrets.
// Tenant-level config (config packs, feature flags, tenant settings) lives in
// the TCM module at src/tenant/.
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: true },
    }),
  ],
  providers: [SupabaseConfigService],
  exports: [SupabaseConfigService],
})
export class AppConfigModule {}
