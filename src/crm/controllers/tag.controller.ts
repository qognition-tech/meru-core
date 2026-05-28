import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { TagService } from '../services/tag.service';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { CreateTagDto, UpdateTagDto } from '../dto/tag.dto';

@Controller('crm/tags')
@ApiTags('CRM / Tags')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new tag' })
  @ApiResponse({ status: 201, description: 'Tag created successfully' })
  async create(@Request() req, @Body() dto: CreateTagDto) {
    return this.tagService.create({
      tenantId: req.user.tenantId,
      name: dto.name,
      color: dto.color,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List all tags for tenant' })
  @ApiResponse({ status: 200, description: 'Tags retrieved' })
  async findAll(@Request() req) {
    return this.tagService.findByTenant(req.user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get tag by ID' })
  @ApiResponse({ status: 200, description: 'Tag retrieved' })
  @ApiResponse({ status: 404, description: 'Tag not found' })
  async findOne(@Param('id') id: string, @Request() req) {
    return this.tagService.findById(id, req.user.tenantId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a tag' })
  async update(
    @Param('id') id: string,
    @Request() req,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tagService.update(id, req.user.tenantId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tag' })
  @ApiResponse({ status: 204, description: 'Tag deleted' })
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    await this.tagService.delete(id, req.user.tenantId);
  }
}