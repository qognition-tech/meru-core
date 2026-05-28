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
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { AuthGuard } from '@nestjs/passport';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';

@ApiTags('documents')
@Controller('documents')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

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
    @Request() req,
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

    return {
      success: true,
      data: {
        document: result.document,
        version: result.version,
        url: result.url,
      },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new document record (without file)' })
  @ApiResponse({ status: 201, description: 'Document created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() dto: CreateDocumentDto, @Request() req) {
    const document = await this.documentsService.create(
      dto,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: document,
    };
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
    @Request() req,
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

    return {
      success: true,
      data: {
        document: result.document,
        version: result.version,
        url: result.url,
      },
    };
  }

  @Get()
  @ApiOperation({ summary: 'Search documents' })
  @ApiResponse({ status: 200, description: 'Documents retrieved successfully' })
  @ApiQuery({ name: 'query', required: false, description: 'Search query' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  async findAll(@Query() searchDto: SearchDocumentsDto, @Request() req) {
    const result = await this.documentsService.findAll(
      req.user.tenantId,
      searchDto,
    );

    return {
      success: true,
      data: result.documents,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get('entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get documents linked to an entity' })
  @ApiResponse({ status: 200, description: 'Documents retrieved successfully' })
  async findByEntity(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Request() req,
  ) {
    const result = await this.documentsService.findAll(req.user.tenantId, {
      linkedEntityType: entityType,
      linkedEntityId: entityId,
    });

    return {
      success: true,
      data: result.documents,
      meta: {
        total: result.total,
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a document by ID' })
  @ApiResponse({ status: 200, description: 'Document retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    const document = await this.documentsService.findOne(
      id,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: document,
    };
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Get all versions of a document' })
  @ApiResponse({
    status: 200,
    description: 'Document versions retrieved successfully',
  })
  async getVersions(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    const versions = await this.documentsService.getVersions(
      id,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: versions,
    };
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
    @Request() req,
  ) {
    const version = await this.documentsService.getVersion(
      id,
      versionId,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: version,
    };
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Get a download URL for a document' })
  @ApiResponse({
    status: 200,
    description: 'Download URL generated successfully',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req,
    @Query('versionId') versionId?: string,
  ) {
    const url = await this.documentsService.downloadUrl(
      id,
      versionId,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: { url },
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a document' })
  @ApiResponse({ status: 200, description: 'Document updated successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req,
  ) {
    const document = await this.documentsService.update(
      id,
      dto,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: document,
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a document' })
  @ApiResponse({ status: 200, description: 'Document deleted successfully' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    await this.documentsService.remove(id, req.user.tenantId, req.user.id);

    return {
      success: true,
      message: 'Document deleted successfully',
    };
  }

  @Post(':id/analyze')
  @ApiOperation({ summary: 'Trigger AI analysis for a document' })
  @ApiResponse({
    status: 200,
    description: 'AI analysis triggered successfully',
  })
  async analyze(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    await this.documentsService.triggerAIAnalysis(
      id,
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      message: 'AI analysis triggered successfully',
    };
  }
}
