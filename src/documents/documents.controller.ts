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
  UploadedFile,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiConsumes,
  ApiQuery,
} from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { DocumentChecklistService } from './document-checklist.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import type { AuthenticatedRequest } from '../common/types';
import { paginated } from '../common/paginated';

@ApiTags('documents')
@Controller('documents')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly documentChecklistService: DocumentChecklistService,
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
      req.user.id,
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
    const result = await this.documentsService.findAll(req.user.tenantId, {
      linkedEntityType: entityType,
      linkedEntityId: entityId,
    });

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
      req.user.id,
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
      req.user.id,
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
      req.user.id,
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
      req.user.id,
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
      req.user.id,
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
    await this.documentsService.remove(id, req.user.tenantId, req.user.id);

    return { deleted: true };
  }

  @Post(':id/analyze')
  @ApiOperation({ summary: 'Trigger AI analysis for a document' })
  @ApiResponse({
    status: 200,
    description: 'AI analysis triggered successfully',
  })
  async analyze(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.documentsService.triggerAIAnalysis(
      id,
      req.user.tenantId,
      req.user.id,
    );

    return { triggered: true };
  }
}
