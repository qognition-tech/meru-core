import {
  Controller,
  Get,
  Post,
  UseGuards,
  Request,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CitationEnforcementInterceptor } from '../ai/interceptors/citation-enforcement.interceptor';
import { OrchestrationService } from './orchestration.service';
import { AgentRegistryService } from './agent-registry.service';
import { AuditService } from '../audit/audit.service';
import { paginated } from '../common/paginated';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from './authenticated-request.interface';

// Citations or silence (CLAUDE.md §5.3). /search/intelligent?includeAI=true
// and /entity/:id/insights both carry LLM output; the interceptor stamps or
// suppresses every AiResponse in the body. The other routes here (agents,
// events, health) return records and probes, not prose, and pass through.
@Controller('orchestration')
@ApiTags('orchestration')
@UseInterceptors(CitationEnforcementInterceptor)
export class OrchestrationController {
  constructor(
    private orchestrationService: OrchestrationService,
    private agentRegistry: AgentRegistryService,
    private auditService: AuditService,
  ) {}

  // ── Autonomous agents ─────────────────────────────────────────────────────
  //
  // The agents are the specialist engines of CLAUDE.md §3 plus the scheduled
  // services. There is no agents *table*: a registry of code that already
  // exists would drift the moment someone added an engine. What is persisted
  // is execution history, which is what the page actually needs and the only
  // part that cannot be derived from the source.

  @Get('agents')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List autonomous agents with this tenant’s run history',
    description:
      'Each agent carries its schedule, last run, today’s execution count and ' +
      'success rate. `runnable: false` marks reactive agents (screening, ' +
      'doc-intel, vessel) that act on a subject rather than on a button.',
  })
  @ApiResponse({ status: 200, description: 'Agents retrieved' })
  async listAgents(@Request() req: AuthenticatedRequest) {
    return this.agentRegistry.listAgents(req.user.tenantId);
  }

  @Get('agents/:id/logs')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Recent runs for one agent, newest first' })
  @ApiParam({ name: 'id', example: 'regulatory-radar' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiResponse({ status: 200, description: 'Logs retrieved' })
  @ApiResponse({ status: 404, description: 'Unknown agent' })
  async agentLogs(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.agentRegistry.getAgentLogs(
      req.user.tenantId,
      id,
      Number.isNaN(parsed) ? undefined : parsed,
    );
  }

  @Post('agents/:id/run')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Trigger an agent now',
    description:
      'Records the attempt before the work starts, so an agent that crashes ' +
      'still leaves evidence it ran. An agent that fails returns 200 with ' +
      '`status: "failed"` — the request succeeded, the run did not, and the ' +
      'page needs to show that rather than treat it as a transport error.',
  })
  @ApiParam({ name: 'id', example: 'regulatory-radar' })
  @ApiResponse({ status: 200, description: 'Run completed or failed' })
  @ApiResponse({ status: 404, description: 'Unknown or non-runnable agent' })
  async runAgent(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.agentRegistry.runAgent(req.user.tenantId, id, req.user.id);
  }

  // ── Activity feed ─────────────────────────────────────────────────────────

  @Get('events')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'System activity feed for this tenant',
    description:
      'A read projection over the audit log rather than a second event store. ' +
      'AUD is already the tamper-evident record of every state change ' +
      '(CLAUDE.md §6.5); duplicating it into an `events` table would create ' +
      'two histories that can disagree.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiResponse({ status: 200, description: 'Events retrieved' })
  async listEvents(
    @Request() req: AuthenticatedRequest,
    @Query('limit') limitRaw?: string,
    @Query('page') pageRaw?: string,
  ) {
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(limitRaw ?? '', 10) || 50),
    );
    const page = Math.max(1, Number.parseInt(pageRaw ?? '', 10) || 1);

    const { logs, total } = await this.auditService.queryLogs({
      tenantId: req.user.tenantId,
      limit,
      offset: (page - 1) * limit,
    });

    const events = logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      description: log.description,
      severity: log.severity,
      actorId: log.userId,
      actorEmail: log.userEmail ?? null,
    }));

    return paginated(events, total, page, limit);
  }

  @Get('health')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Health check for orchestration services' })
  @ApiResponse({ status: 200, description: 'Health status' })
  async health() {
    return this.orchestrationService.healthCheck();
  }

  // Both carry LLM output over CRM records and had no `@Roles` at all —
  // `PolicyGuard`'s role check is a no-op when the reflector finds nothing to
  // check, so a bare `client` token reached both. Gated to match their
  // already-staff-gated siblings (`agents/:id/run`, `events`) — a client's
  // "own case" answer is `GET /crm/entities/:id`, not a cross-record search or
  // an AI risk assessment on any entity id it can guess. The guard alone is
  // not the whole fix: `actor` is also threaded into the service calls below
  // so the underlying primitives (`SearchService.scopeResults`,
  // `CrmService.getEntity`) stay correct in their own right — defence in
  // depth, not "the guard will catch it".

  @Get('search/intelligent')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
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
      req.user,
    );
  }

  @Get('entity/:id/insights')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get AI-generated insights for an entity' })
  @ApiResponse({ status: 200, description: 'Entity insights' })
  @ApiResponse({ status: 404, description: "Not found, or not this caller's" })
  async getEntityInsights(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.orchestrationService.extractInsights(
      req.user.tenantId,
      id,
      req.user,
      req.tenantVertical,
    );
  }
}
