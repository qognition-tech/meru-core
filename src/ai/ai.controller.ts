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
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { CitationEnforcementInterceptor } from './interceptors/citation-enforcement.interceptor';
import type { AiRequest } from './ai.service';
import type { AuthenticatedRequest } from '../orchestration/authenticated-request.interface';
import { AiPrompt, PromptCategory } from './entities/ai-prompt.entity';
import { VerticalType } from '../iam/enums/vertical.enum';
import {
  AnalyzeEntityDto,
  CreateEmbeddingDto,
  ExecutePromptDto,
  UpsertPromptDto,
} from './dto/ai-request.dto';

interface AnalyzeEntityBody {
  vertical?: VerticalType;
  [key: string]: unknown;
}

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
  async execute(
    @Request() req: AuthenticatedRequest,
    @Body() aiRequest: ExecutePromptDto,
  ) {
    return this.aiService.execute({
      ...aiRequest,
      tenantId: req.user.tenantId,
      // The prompt library lives in the tenant's vertical pack, so the vertical
      // is what selects it. PolicyGuard has already resolved and attached it
      // (policy.guard.ts:53); an explicit `vertical` in the body still wins so
      // an operator can target another vertical's prompt deliberately.
      vertical: aiRequest.vertical ?? (req.tenantVertical as VerticalType),
    });
  }

  @Post('analyze-entity/:id')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Analyze a CRM entity using AI' })
  @ApiResponse({ status: 200, description: 'Entity analysis result' })
  async analyzeEntity(
    @Request() req: AuthenticatedRequest,
    @Body() entityData: AnalyzeEntityDto,
  ) {
    return this.aiService.analyzeEntity(
      req.user.tenantId,
      entityData,
      entityData.vertical ?? VerticalType.IMMIGRATION,
    );
  }

  @Post('embeddings')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create an embedding for text' })
  @ApiResponse({ status: 200, description: 'Embedding created' })
  async createEmbedding(
    @Request() req: AuthenticatedRequest,
    @Body() data: CreateEmbeddingDto,
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
    @Request() req: AuthenticatedRequest,
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
  async getPrompts(
    @Request() req: AuthenticatedRequest,
    @Query('category') category?: string,
  ) {
    return this.aiService.getPromptsByCategory(
      category as PromptCategory,
      req.user.tenantId,
    );
  }

  @Post('prompts')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  // A mutating route with no role check at all — any authenticated caller,
  // including a `client` token, could overwrite a prompt's template. `key`
  // is globally unique on `AiPrompt` (see `resolvePrompt`'s own comment), so
  // this is also a *cross-tenant* overwrite primitive: naming another
  // tenant's `key` replaces their live prompt. Matches the guard already on
  // `POST /search/index/entity` and `POST /search/index/bulk` for the same
  // shape of route.
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create or update a prompt' })
  @ApiResponse({ status: 200, description: 'Prompt saved' })
  @ApiResponse({ status: 403, description: 'Platform admin or firm admin only' })
  async upsertPrompt(@Body() promptData: UpsertPromptDto) {
    return this.aiService.upsertPrompt(promptData);
  }
}
