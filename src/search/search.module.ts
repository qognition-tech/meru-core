import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchIndex } from './entities/search-index.entity';
import { CoreModule } from '../core/core.module';
import { ElasticsearchModule } from './elasticsearch/elasticsearch.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SearchIndex]),
    CoreModule,
    // The driver. SearchService delegates to it when the cluster is up and
    // falls back to Postgres when it is not; callers never see which.
    ElasticsearchModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
