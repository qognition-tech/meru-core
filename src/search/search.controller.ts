import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { SearchResponseDto } from './dto/search-result.dto';
import { AuthGuard } from '@nestjs/passport';
import { SearchService } from './search.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { BulkIndexDto, IndexEntityDto } from './dto/index-entity.dto';

@Controller('search')
@ApiTags('search')
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Search across tenant data' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results',
  })
  @ApiResponse({
    status: 200,
    description:
      'Search results. `results` is empty (not an error) for a blank query or a tenant with nothing indexed; `total` is the count returned, bounded by `limit`.',
    type: SearchResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async search(
    @Request() req,
    @Query('q') query: string,
    @Query('limit') limit?: number,
  ) {
    if (!query || query.trim().length === 0) {
      return { results: [], total: 0 };
    }
    // One shape on both branches. The service returns a bare array; the
    // blank-query branch above returned `{results, total}` and consumers had
    // to guess which they would get.
    const results = await this.searchService.search(
      req.user.tenantId,
      query.trim(),
      limit ? parseInt(limit.toString()) : 20,
    );
    return { results, total: results.length };
  }

  @Post('index/bulk')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Rebuild search index for tenant' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        entities: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Index rebuild started' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async rebuildIndex(@Body() data: BulkIndexDto) {
    return this.searchService.indexBulk(data.entities);
  }

  @Post('index/entity')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Index a CRM entity' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        entity: { type: 'object' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Entity indexed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async indexEntity(@Body() data: IndexEntityDto) {
    return this.searchService.indexEntityData(data.entity);
  }
}
