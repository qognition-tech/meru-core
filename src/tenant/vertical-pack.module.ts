import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigPack } from './entities/config-pack.entity';
import { TenantConfigPin } from '../iam/entities/tenant-config-pin.entity';
import { VerticalPackService } from './services/vertical-pack.service';

/**
 * Read-only access to Layer 4, for any module that needs it.
 *
 * Separate from `TenantModule` on purpose. TenantModule pulls in Billing and
 * Audit, and the modules that need pack data most — AI, COM, DOC — are already
 * threading `forwardRef` through those same services to break cycles. Importing
 * the whole of TCM just to read one JSON key would deepen a dependency graph
 * that is already the reason `ai.service.ts` has five `forwardRef`s.
 *
 * So this module has exactly one provider and two entities (the pack, and the
 * tenant pin that selects one), and nothing can import a cycle through it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ConfigPack, TenantConfigPin])],
  providers: [VerticalPackService],
  exports: [VerticalPackService],
})
export class VerticalPackModule {}
