import {
  Controller,
  Get,
  UseGuards,
  Request,
  Query,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { OrchestrationService } from './orchestration.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import type { AuthenticatedRequest } from './authenticated-request.interface';

@Controller('orchestration')
@ApiTags('orchestration')
export class OrchestrationController {
  constructor(private orchestrationService: OrchestrationService) {}

  @Get('health')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Health check for orchestration services' })
  @ApiResponse({ status: 200, description: 'Health status' })
  async health() {
    return this.orchestrationService.healthCheck();
  }

  @Get('search/intelligent')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Perform intelligent AI-enhanced search' })
  @ApiResponse({ status: 200, description: 'Search results with AI analysis' })
  async intelligentSearch(
    @Request() req: AuthenticatedRequest,
    @Query('query') query: string,
    @Query('includeAI') includeAI?: string,
    @Query('searchType') searchType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orchestrationService.performIntelligentSearch(
      req.user.tenantId,
      query,
      {
        includeAIAnalysis: includeAI === 'true',
        searchType:
          (searchType as 'semantic' | 'keyword' | 'hybrid') || undefined,
        limit: limit ? parseInt(limit, 10) : 20,
      },
    );
  }

  @Get('entity/:id/insights')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get AI-generated insights for an entity' })
  @ApiResponse({ status: 200, description: 'Entity insights' })
  async getEntityInsights(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.orchestrationService.extractInsights(req.user.tenantId, id);
  }
}
