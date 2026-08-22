import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { EntityRelation } from './entities/entity-relation.entity';
import { EntityRelationService } from './entity-relation.service';
import { CommentService } from './comment.service';
import { TenantModule } from '../tenant/tenant.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { CoreModule } from '../core/core.module';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';
import { AcceptanceService } from './acceptance.service';
import { PackRuleModule } from '../rules/pack-rule.module';

// CRM module per CLAUDE.md §2 row 3: polymorphic UniversalEntity.
// All types (person, organization, case, note, tag, asset) live in one table.
// Type-specific fields go in verticalAttributes jsonb.
@Module({
  imports: [
    TypeOrmModule.forFeature([UniversalEntity, EntityRelation]),
    TenantModule,
    // `EntityRelationService` reads the pack's `relationships[]`. TenantModule
    // does not export `VerticalPackService`, so without this the app does not
    // boot at all — Nest reports an unresolvable dependency and exits.
    VerticalPackModule,
    CoreModule,
    SearchModule,
    DocumentsModule,
    AuditModule,
    // `GET /crm/entities/:id/rules` — the pack's `rules[]`, evaluated.
    // PackRuleModule, NOT RulesModule: the latter closes an import cycle
    // through Tasks → Documents → Crm. See its header.
    PackRuleModule,
  ],
  controllers: [CrmController],
  providers: [
    CrmService,
    EntityRelationService,
    CommentService,
    AcceptanceService,
  ],
  exports: [CrmService, EntityRelationService, CommentService],
})
export class CrmModule {}
