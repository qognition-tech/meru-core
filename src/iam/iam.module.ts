import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IamController } from './iam.controller';
import { UsersController } from './users.controller';
import { IamService } from './iam.service';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthToken } from './entities/auth-token.entity';
import { TenantConfigPin } from './entities/tenant-config-pin.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { PolicyGuard } from './guards/policy.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { CoreModule } from '../core/core.module';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { PlatformController } from './platform.controller';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { AuditModule } from '../audit/audit.module';
import { SamlService } from './services/saml.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      Role,
      Session,
      ApiKey,
      AuthToken,
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
  controllers: [
    IamController,
    UsersController,
    TenantProvisioningController,
    PlatformController,
  ],
  providers: [
    IamService,
    JwtStrategy,
    LocalStrategy,
    PolicyGuard,
    JwtAuthGuard,
    TenantProvisioningService,
    SamlService,
  ],
  exports: [
    IamService,
    PolicyGuard,
    JwtAuthGuard,
    JwtStrategy,
    SamlService,
    JwtModule,
  ],
})
export class IamModule {
  configure(consumer: any) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
