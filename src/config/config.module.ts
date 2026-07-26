import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration, validationSchema } from './configuration';

// App-boot configuration only — env validation and AWS secrets. Tenant-level
// config (config packs, feature flags, tenant settings) lives in the TCM module
// at src/tenant/.
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
})
export class AppConfigModule {}
