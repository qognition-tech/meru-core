import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  ServiceUnavailableException,
  UploadedFile,
  BadRequestException,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiConsumes,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { DocumentChecklistService } from './document-checklist.service';
import { DocumentGenerationService } from './document-generation.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { CitationEnforcementInterceptor } from '../ai/interceptors/citation-enforcement.interceptor';
import type { AuthenticatedRequest } from '../common/types';
import { paginated } from '../common/paginated';
import type { Response } from 'express';

@ApiTags('documents')
// Citations or silence (CLAUDE.md §5.3). No route here returns generated
// prose today — documents, versions, checklists and generated PDFs are
// records, and the PDF body is produced from a pack template, not a model —
// so the interceptor passes everything through. It is applied so that when
// `:id/analyze` becomes real, its summary is enforced from the first request.
@Controller('documents')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@UseInterceptors(CitationEnforcementInterceptor)
@ApiBearerAuth('JWT-auth')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly documentChecklistService: DocumentChecklistService,
    private readonly generation: DocumentGenerationService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a new document' })
  @ApiResponse({ status: 201, description: 'Document uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const result = await this.documentsService.upload(
      file,
      dto,
      req.user.tenantId,
      req.user.id,
    );

    return result;
  }

  @Post()
  @ApiOperation({ summary: 'Create a new document record (without file)' })
  @ApiResponse({ status: 201, description: 'Document created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(
    @Body() dto: CreateDocumentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const document = await this.documentsService.create(
      dto,
      req.user.tenantId,
      req.user.id,
    );

    return document;
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a new version of a document' })
  @ApiResponse({
    status: 201,
    description: 'Document version created successfully',
  })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async createNewVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('changeDescription') changeDescription: string,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const result = await this.documentsService.createNewVersion(
      id,
      file,
      changeDescription || `Version update by ${req.user.email}`,
      req.user.tenantId,
      req.user,
    );

    return result;
  }

  @Get('checklist')
  @ApiOperation({
    summary: 'Which documents a case still needs, per the config pack',
    description:
      'Requirements come from the tenant vertical\'s config pack ' +
      '(`schema.documentTypes`), never from code — a hardcoded checklist ' +
      'means a pack update silently stops reaching users. Pass ?entityId= to ' +
      'mark what has already been supplied; without it every item reports ' +
      '`uploaded: null` ("not asked"), which must not render the same as ' +
      '`false` ("missing").',
  })
  @ApiQuery({
    name: 'entityId',
    required: false,
    description: 'Case/matter id to check uploads against',
  })
  @ApiResponse({ status: 200, description: 'Checklist retrieved' })
  @ApiResponse({
    status: 404,
    description: 'No active config pack for this vertical',
  })
  async checklist(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Query('entityId') entityId?: string,
  ) {
    return this.documentChecklistService.forEntity(
      req.user.tenantId,
      req.tenantVertical ?? null,
      entityId,
    );
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Documents this tenant can generate',
    description:
      "From the vertical pack's `documentTemplates[]` — the counterpart to " +
      '`documentTypes`, which are documents the platform *collects*. Render the ' +
      'list from this response; the set differs per vertical and per country.',
  })
  @ApiResponse({ status: 200, description: 'Templates retrieved' })
  async listTemplates(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
  ) {
    return this.generation.listTemplates(req.tenantVertical ?? null);
  }

  @Post('generate/:templateKey')
  @ApiOperation({
    summary: 'Generate a document from a pack template',
    description:
      'Returns the PDF bytes directly (`application/pdf`), so a UI can stream ' +
      'it to the browser or attach it. Pass `?store=true` to also file it as a ' +
      "versioned document against the record, which is what the client's " +
      'document list reads.\n\n' +
      '**A template may refuse.** When it declares `requires` and one of those ' +
      'paths is empty on the record — a cost agreement with no fee, an invoice ' +
      'with no amount — the response is a 400 naming the missing paths rather ' +
      'than a document with blanks in it. Surface that message: it tells the ' +
      'user exactly which field to fill in.\n\n' +
      '`X-Unresolved-Placeholders` reports any *non*-required placeholder that ' +
      'came back empty. The document is still produced; the header is there so ' +
      'a UI can warn before the firm sends a half-filled letter.',
  })
  @ApiParam({ name: 'templateKey', example: 'cost_agreement' })
  @ApiQuery({
    name: 'entityId',
    required: false,
    description: 'The record the document is about. Required by most templates.',
  })
  @ApiQuery({
    name: 'store',
    required: false,
    type: Boolean,
    description: 'Also file the result as a versioned document on the record.',
  })
  @ApiResponse({ status: 200, description: 'PDF bytes' })
  @ApiResponse({
    status: 400,
    description: 'A required value is missing on the record',
  })
  @ApiResponse({ status: 404, description: 'No such template in this pack' })
  async generate(
    @Request() req: AuthenticatedRequest & { tenantVertical?: string | null },
    @Param('templateKey') templateKey: string,
    @Res() res: Response,
    @Query('entityId') entityId?: string,
    @Query('store') store?: string,
  ) {
    const result = await this.generation.generate(
      req.user.tenantId,
      req.tenantVertical ?? null,
      templateKey,
      entityId,
    );

    if (store === 'true') {
      await this.generation.store(result, req.user.tenantId, req.user.id, entityId);
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"`,
    );
    if (result.unresolved.length) {
      res.setHeader('X-Unresolved-Placeholders', result.unresolved.join(','));
    }
    res.send(result.bytes);
  }

  @Get()
  @ApiOperation({ summary: 'Search documents' })
  @ApiResponse({ status: 200, description: 'Documents retrieved successfully' })
  @ApiQuery({ name: 'query', required: false, description: 'Search query' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  async findAll(
    @Query() searchDto: SearchDocumentsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const result = await this.documentsService.findAll(
      req.user.tenantId,
      searchDto,
      req.user,
    );

    return paginated(result.documents, result.total, result.page, result.limit);
  }

  @Get('entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get documents linked to an entity' })
  @ApiResponse({ status: 200, description: 'Documents retrieved successfully' })
  async findByEntity(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const result = await this.documentsService.findAll(
      req.user.tenantId,
      { linkedEntityType: entityType, linkedEntityId: entityId },
      req.user,
    );

    return paginated(result.documents, result.total);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a document by ID' })
  @ApiResponse({ status: 200, description: 'Document retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const document = await this.documentsService.findOne(
      id,
      req.user.tenantId,
      req.user,
    );

    return document;
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Get all versions of a document' })
  @ApiResponse({
    status: 200,
    description: 'Document versions retrieved successfully',
  })
  async getVersions(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const versions = await this.documentsService.getVersions(
      id,
      req.user.tenantId,
      req.user,
    );

    return versions;
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'Get a specific version of a document' })
  @ApiResponse({
    status: 200,
    description: 'Document version retrieved successfully',
  })
  async getVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const version = await this.documentsService.getVersion(
      id,
      versionId,
      req.user.tenantId,
      req.user,
    );

    return version;
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Get a download URL for a document' })
  @ApiResponse({
    status: 200,
    description: 'Download URL generated successfully',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Query('versionId') versionId?: string,
  ) {
    const url = await this.documentsService.downloadUrl(
      id,
      versionId,
      req.user.tenantId,
      req.user,
    );

    return { url };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a document' })
  @ApiResponse({ status: 200, description: 'Document updated successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const document = await this.documentsService.update(
      id,
      dto,
      req.user.tenantId,
      req.user,
    );

    return document;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a document' })
  @ApiResponse({ status: 200, description: 'Document deleted successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.documentsService.remove(id, req.user.tenantId, req.user);

    return { deleted: true };
  }

  // Exempt from citation enforcement by shape, not by intent: this returns no
  // prose. It answers 503 until document analysis exists — it used to answer
  // `{ triggered: true }` over a stub that wrote `riskLevel: 'low'` without
  // reading the file (see DocumentsService.triggerAIAnalysis).
  @Post(':id/analyze')
  @ApiOperation({ summary: 'Trigger AI analysis for a document' })
  @ApiResponse({ status: 200, description: 'AI analysis triggered' })
  @ApiResponse({
    status: 503,
    description:
      'Document analysis is not implemented; body carries unavailableReason',
  })
  async analyze(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const outcome = await this.documentsService.triggerAIAnalysis(
      id,
      req.user.tenantId,
      req.user,
    );
    if (!outcome.analyzed) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: outcome.unavailableReason,
        triggered: false,
        unavailableReason: outcome.unavailableReason,
      });
    }
    return { triggered: true };
  }
}
