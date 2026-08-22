import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchIndex } from './entities/search-index.entity';
import { CoreModule } from '../core/core.module';
import { ElasticsearchCoreModule } from './elasticsearch/elasticsearch-core.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SearchIndex]),
    CoreModule,
    // The driver. SearchService delegates to it when the cluster is up and
    // falls back to Postgres when it is not; callers never see which.
    // The *core* module: the routed ElasticsearchModule imports IamModule
    // and closes an import cycle — see elasticsearch-core.module.ts.
    ElasticsearchCoreModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
