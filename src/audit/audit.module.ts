import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { RetentionService } from './retention.service';
import { Tenant } from '../iam/entities/tenant.entity';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { AuditLog } from './entities/audit-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, Tenant]),
    // Retention periods are Layer 4: `compliance.retentionYears`.
    VerticalPackModule,
  ],
  controllers: [AuditController],
  providers: [AuditService, RetentionService],
  exports: [AuditService, RetentionService],
})
export class AuditModule {}
