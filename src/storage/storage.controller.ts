import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { StorageService } from './storage.service';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import type { UserPayload } from '../common/types';
import { TenantId } from '../tenant/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../iam/guards/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import {
  UploadFileDto,
  UpdateFileDto,
  SearchFilesDto,
  MoveFileDto,
  CopyFileDto,
  PresignedUrlDto,
  InitiateMultipartUploadDto,
  CompleteMultipartUploadDto,
  CreateVersionDto,
} from './dto/storage.dto';
import { StorageFile, FileVersion } from './entities/storage-file.entity';
import {
  StorageClass,
  FileStatus,
  StorageMetrics,
} from './interfaces/storage.interface';

@ApiTags('Storage')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  // ==================== UPLOAD ====================

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a file',
    description: 'Upload a file to cloud storage with metadata support',
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 201,
    description: 'File uploaded successfully',
    type: StorageFile,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or metadata' })
  @ApiResponse({ status: 413, description: 'File too large' })
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadFileDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.upload({
      tenantId,
      fileName: dto.fileName || file.originalname,
      mimeType: dto.mimeType || file.mimetype,
      size: file.size,
      buffer: file.buffer,
      metadata: dto.metadata,
      tags: dto.tags,
      storageClass: dto.storageClass,
      access: dto.access,
      expiresInDays: dto.expiresInDays,
      encrypt: dto.encrypt,
      folder: dto.folder,
      userId: actor.id,
    });
  }

  @Post('multipart/initiate')
  @ApiOperation({
    summary: 'Initiate multipart upload',
    description: 'Start a large file multipart upload',
  })
  @ApiResponse({ status: 201, description: 'Multipart upload initiated' })
  async initiateMultipartUpload(
    @Body() dto: InitiateMultipartUploadDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<{
    uploadId: string;
    fileId: string;
    uploadUrls: { partNumber: number; url: string }[];
  }> {
    return this.storageService.initiateMultipartUpload(
      tenantId,
      dto.fileName,
      dto.mimeType,
      dto.totalSize,
      actor.id,
      dto.partSize,
      dto.metadata,
    );
  }

  @Post('multipart/complete')
  @ApiOperation({
    summary: 'Complete multipart upload',
    description: 'Finalize a multipart upload with part ETags',
  })
  @ApiResponse({
    status: 200,
    description: 'Multipart upload completed',
    type: StorageFile,
  })
  async completeMultipartUpload(
    @Body() dto: CompleteMultipartUploadDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.completeMultipartUpload(
      dto.uploadId,
      dto.partETags,
      tenantId,
      actor,
    );
  }

  // ==================== FILE OPERATIONS ====================

  @Get('files')
  @ApiOperation({
    summary: 'List files',
    description: 'Search and list files with filters',
  })
  @ApiResponse({ status: 200, description: 'Files retrieved successfully' })
  @ApiQuery({ name: 'query', required: false, description: 'Search query' })
  @ApiQuery({ name: 'folder', required: false, description: 'Folder path' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page',
  })
  async listFiles(
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
    @Query() query: SearchFilesDto,
  ): Promise<{ files: StorageFile[]; total: number }> {
    return this.storageService.searchFiles({
      tenantId,
      query: query.query,
      folder: query.folder,
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy as any,
      sortOrder: query.sortOrder,
    });
  }

  @Get('files/:id')
  @ApiOperation({
    summary: 'Get file details',
    description: 'Retrieve file metadata and versions',
  })
  @ApiResponse({
    status: 200,
    description: 'File retrieved successfully',
    type: StorageFile,
  })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.getFile(fileId, tenantId, actor);
  }

  @Patch('files/:id')
  @ApiOperation({
    summary: 'Update file metadata',
    description: 'Update file metadata, tags, or storage class',
  })
  @ApiResponse({
    status: 200,
    description: 'File updated successfully',
    type: StorageFile,
  })
  async updateFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: UpdateFileDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.updateFile(
      fileId,
      {
        metadata: dto.metadata,
        tags: dto.tags,
        storageClass: dto.storageClass,
        access: dto.access,
        status: dto.status,
      },
      tenantId,
      actor,
    );
  }

  @Delete('files/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete file',
    description: 'Soft delete a file (can be restored)',
  })
  @ApiResponse({ status: 204, description: 'File deleted successfully' })
  @ApiQuery({
    name: 'permanent',
    required: false,
    type: Boolean,
    description: 'Permanently delete file',
  })
  async deleteFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Query('permanent') permanent: boolean,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<void> {
    await this.storageService.deleteFile(fileId, tenantId, actor, permanent);
  }

  @Post('files/:id/restore')
  @ApiOperation({
    summary: 'Restore deleted file',
    description: 'Restore a soft-deleted file',
  })
  @ApiResponse({
    status: 200,
    description: 'File restored successfully',
    type: StorageFile,
  })
  async restoreFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.restoreFile(fileId, tenantId, actor);
  }

  // ==================== DOWNLOAD ====================

  @Get('files/:id/download')
  @ApiOperation({
    summary: 'Get download URL',
    description: 'Get a presigned URL for file download',
  })
  @ApiResponse({ status: 200, description: 'Download URL generated' })
  async getDownloadUrl(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Query() dto: PresignedUrlDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<{ url: string; expiresIn: number }> {
    const url = await this.storageService.getPresignedUrl(fileId, {
      fileId,
      tenantId,
      actor,
      expiresInSeconds: dto.expiresInSeconds,
      responseDisposition: dto.responseDisposition,
    });

    return { url, expiresIn: dto.expiresInSeconds || 3600 };
  }

  // ==================== VERSIONS ====================

  @Get('files/:id/versions')
  @ApiOperation({
    summary: 'List file versions',
    description: 'Get all versions of a file',
  })
  @ApiResponse({
    status: 200,
    description: 'Versions retrieved successfully',
    type: [FileVersion],
  })
  async getVersions(
    @Param('id', ParseUUIDPipe) fileId: string,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<FileVersion[]> {
    return this.storageService.getVersions(fileId, tenantId, actor);
  }

  @Post('files/:id/versions')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Create new version',
    description: 'Upload a new version of an existing file',
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 201,
    description: 'Version created successfully',
    type: FileVersion,
  })
  async createVersion(
    @Param('id', ParseUUIDPipe) fileId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateVersionDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<FileVersion> {
    return this.storageService.createVersion(
      fileId,
      file.buffer,
      dto.changeDescription,
      tenantId,
      actor,
    );
  }

  // ==================== FILE MANAGEMENT ====================

  @Post('files/:id/move')
  @ApiOperation({
    summary: 'Move file',
    description: 'Move a file to a different folder',
  })
  @ApiResponse({
    status: 200,
    description: 'File moved successfully',
    type: StorageFile,
  })
  async moveFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: MoveFileDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.moveFile(
      fileId,
      dto.destinationFolder,
      tenantId,
      actor,
    );
  }

  @Post('files/:id/copy')
  @ApiOperation({
    summary: 'Copy file',
    description: 'Create a copy of a file',
  })
  @ApiResponse({
    status: 201,
    description: 'File copied successfully',
    type: StorageFile,
  })
  async copyFile(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: CopyFileDto,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.copyFile(
      fileId,
      dto.destinationFolder,
      dto.newName,
      tenantId,
      actor,
    );
  }

  @Patch('files/:id/storage-class')
  @ApiOperation({
    summary: 'Change storage class',
    description:
      'Change the storage class of a file (Standard, Infrequent, Archive)',
  })
  @ApiResponse({
    status: 200,
    description: 'Storage class changed successfully',
    type: StorageFile,
  })
  async changeStorageClass(
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body('storageClass') storageClass: StorageClass,
    @TenantId() tenantId: string,
    @CurrentUser() actor: UserPayload,
  ): Promise<StorageFile> {
    return this.storageService.changeStorageClass(
      fileId,
      storageClass,
      tenantId,
      actor,
    );
  }

  // ==================== METRICS ====================

  @Get('metrics')
  @ApiOperation({
    summary: 'Get storage metrics',
    description: 'Retrieve storage usage metrics for the tenant',
  })
  @ApiResponse({ status: 200, description: 'Metrics retrieved successfully' })
  async getMetrics(@TenantId() tenantId: string): Promise<StorageMetrics> {
    return this.storageService.getMetrics(tenantId);
  }
}
