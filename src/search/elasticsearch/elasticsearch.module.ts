import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ElasticsearchService } from './elasticsearch.service';
import { ElasticsearchController } from './elasticsearch.controller';
import { ElasticsearchIndex, ElasticsearchDocument, ElasticsearchSearchLog } from './entities/search-index.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ElasticsearchIndex, ElasticsearchDocument, ElasticsearchSearchLog])],
  providers: [ElasticsearchService],
  controllers: [ElasticsearchController],
  exports: [ElasticsearchService],
})
export class ElasticsearchModule {}
