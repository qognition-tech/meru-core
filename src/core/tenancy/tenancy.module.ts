import { Global, Module, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditModule } from '../../audit/audit.module';
import { applyRlsToDataSource, assertRlsEnforceable } from './rls.datasource';
import { TenancyService } from './tenancy.service';

/**
 * Wires database-level tenant isolation (CLAUDE.md §6.4).
 *
 * Global so that `TenancyService` is injectable anywhere without every feature
 * module re-importing it — the alternative encourages call sites to reach for
 * raw repositories instead of the audited bypass helpers.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    applyRlsToDataSource(this.dataSource);
    await assertRlsEnforceable(this.dataSource);
  }
}
