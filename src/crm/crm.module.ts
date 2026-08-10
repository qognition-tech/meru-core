import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { EntityRelation } from './entities/entity-relation.entity';
import { EntityRelationService } from './entity-relation.service';
import { TenantModule } from '../tenant/tenant.module';
import { CoreModule } from '../core/core.module';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';

// CRM module per CLAUDE.md §2 row 3: polymorphic UniversalEntity.
// All types (person, organization, case, note, tag, asset) live in one table.
// Type-specific fields go in verticalAttributes jsonb.
@Module({
  imports: [
    TypeOrmModule.forFeature([UniversalEntity, EntityRelation]),
    TenantModule,
    CoreModule,
    SearchModule,
    DocumentsModule,
    AuditModule,
  ],
  controllers: [CrmController],
  providers: [CrmService, EntityRelationService],
  exports: [CrmService, EntityRelationService],
})
export class CrmModule {}
