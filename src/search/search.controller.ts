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
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
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
    //
    // `req.user` narrows a `client`'s results to their own records — see
    // `SearchService.search`. Titles and snippets of every other applicant's
    // record used to come back to any authenticated tenant token.
    const results = await this.searchService.search(
      req.user.tenantId,
      query.trim(),
      limit ? parseInt(limit.toString()) : 20,
      req.user,
    );
    return { results, total: results.length };
  }

  @Post('index/bulk')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Rebuild search index for tenant',
    description:
      "`tenantId` is always the caller's own — see `SearchService.indexEntityData` " +
      "— never whatever the body's entities claim.",
  })
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
  @ApiResponse({ status: 403, description: 'Staff only' })
  async rebuildIndex(@Request() req, @Body() data: BulkIndexDto) {
    return this.searchService.indexBulk(data.entities, req.user.tenantId);
  }

  @Post('index/entity')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Index a CRM entity',
    description:
      "`tenantId` is always the caller's own — never the body's `entity.tenantId`. " +
      'Was previously trusted from the request body, making this a cross-tenant ' +
      'overwrite primitive: any authenticated caller could name another tenant.',
  })
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
  @ApiResponse({ status: 403, description: 'Staff only' })
  async indexEntity(@Request() req, @Body() data: IndexEntityDto) {
    return this.searchService.indexEntityData(data.entity, req.user.tenantId);
  }
}
