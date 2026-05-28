import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CaseController } from './controllers/case.controller';
import { NoteController } from './controllers/note.controller';
import { TagController } from './controllers/tag.controller';
import { CaseService } from './services/case.service';
import { NoteService } from './services/note.service';
import { TagService } from './services/tag.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { Case } from './entities/case.entity';
import { Note } from './entities/note.entity';
import { Tag } from './entities/tag.entity';
import { TenantModule } from '../tenant/tenant.module';
import { CoreModule } from '../core/core.module';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UniversalEntity, Case, Note, Tag]),
    TenantModule,
    CoreModule,
    SearchModule,
    DocumentsModule,
    AuditModule,
  ],
  controllers: [CrmController, CaseController, NoteController, TagController],
  providers: [CrmService, CaseService, NoteService, TagService],
  exports: [CrmService, CaseService, NoteService, TagService],
})
export class CrmModule {}
