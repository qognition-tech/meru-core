import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configuration, validationSchema } from './configuration';
import { SupabaseConfigService } from './supabase-config.service';
import { ConfigPack } from './entities/config-pack.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { TenantConfigPin } from '../iam/entities/tenant-config-pin.entity';
import { ConfigPackService } from './services/config-pack.service';
import { ConfigPackController } from './controllers/config-pack.controller';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: true },
    }),
    TypeOrmModule.forFeature([ConfigPack, FeatureFlag, TenantConfigPin]),
  ],
  controllers: [ConfigPackController],
  providers: [SupabaseConfigService, ConfigPackService],
  exports: [ConfigService, SupabaseConfigService, ConfigPackService],
})
export class AppConfigModule {}
