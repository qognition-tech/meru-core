import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IamController } from './iam.controller';
import { IamService } from './iam.service';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { TenantConfigPin } from './entities/tenant-config-pin.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { CoreModule } from '../core/core.module';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      Role,
      Session,
      ApiKey,
      TenantConfigPin,
      TenantSetting,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('jwt.secret') || 'default-secret',
        signOptions: { expiresIn: configService.get('jwt.expiresIn') || '1h' },
      }),
      inject: [ConfigService],
    }),
    CoreModule,
    AuditModule,
  ],
  controllers: [IamController, TenantProvisioningController],
  providers: [IamService, JwtStrategy, PolicyGuard, TenantProvisioningService],
})
export class IamModule {
  configure(consumer: any) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
