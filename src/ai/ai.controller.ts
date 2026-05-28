import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { CitationEnforcementInterceptor } from './interceptors/citation-enforcement.interceptor';
import type { AiRequest } from './ai.service';

// CLAUDE.md §6.3: ALL AI responses are citation-enforced.
// CitationEnforcementInterceptor replaces any response that lacks sources[]
// with the standard "no verified source" fallback.
@Controller('ai')
@ApiTags('ai')
@UseInterceptors(CitationEnforcementInterceptor)
export class AiController {
  constructor(private aiService: AiService) {}

  @Post('execute')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Execute an AI prompt' })
  @ApiResponse({ status: 200, description: 'AI response' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async execute(@Request() req, @Body() aiRequest: AiRequest) {
    return this.aiService.execute({
      ...aiRequest,
      tenantId: req.user.tenantId,
    });
  }

  @Post('analyze-entity/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Analyze a CRM entity using AI' })
  @ApiResponse({ status: 200, description: 'Entity analysis result' })
  async analyzeEntity(@Request() req, @Body() entityData: any) {
    return this.aiService.analyzeEntity(
      req.user.tenantId,
      entityData,
      entityData.vertical || 'immigration',
    );
  }

  @Post('embeddings')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create an embedding for text' })
  @ApiResponse({ status: 200, description: 'Embedding created' })
  async createEmbedding(
    @Request() req,
    @Body()
    data: {
      text: string;
      type: string;
      resourceId: string;
      metadata?: Record<string, any>;
    },
  ) {
    return this.aiService.createEmbedding(
      req.user.tenantId,
      data.text,
      data.type,
      data.resourceId,
      data.metadata,
    );
  }

  @Get('search')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Semantic search using embeddings' })
  @ApiQuery({ name: 'query', required: true })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Search results' })
  async semanticSearch(
    @Request() req,
    @Query('query') query: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    return this.aiService.semanticSearch(
      req.user.tenantId,
      query,
      type,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  @Get('prompts')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get available prompts' })
  @ApiQuery({ name: 'category', required: false })
  @ApiResponse({ status: 200, description: 'Prompts list' })
  async getPrompts(@Request() req, @Query('category') category?: string) {
    return this.aiService.getPromptsByCategory(
      category as any,
      req.user.tenantId,
    );
  }

  @Post('prompts')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create or update a prompt' })
  @ApiResponse({ status: 200, description: 'Prompt saved' })
  async upsertPrompt(@Body() promptData: any) {
    return this.aiService.upsertPrompt(promptData);
  }
}
