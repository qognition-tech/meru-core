import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ElasticsearchService } from './elasticsearch.service';
import {
  ElasticsearchIndex,
  ElasticsearchDocument,
  ElasticsearchSearchLog,
} from './entities/search-index.entity';

/**
 * The Elasticsearch driver and nothing else — no controller, no IamModule.
 *
 * `ElasticsearchModule` (the routed one) imports IamModule for its guards,
 * and IamModule sits upstream of SearchModule via Billing, so importing it
 * from SearchModule made a cycle that took production down on 2026-08-22
 * with "Nest cannot create the ElasticsearchModule instance". SearchModule
 * imports this leaf instead. Both modules provide the same service class;
 * each gets its own instance and its own boot-time ping, which is harmless.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ElasticsearchIndex,
      ElasticsearchDocument,
      ElasticsearchSearchLog,
    ]),
  ],
  providers: [ElasticsearchService],
  exports: [ElasticsearchService],
})
export class ElasticsearchCoreModule {}
