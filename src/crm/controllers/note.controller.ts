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
import { NoteService } from '../services/note.service';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { CreateNoteDto, UpdateNoteDto, NoteFilterDto } from '../dto/note.dto';

@Controller('crm/notes')
@ApiTags('CRM / Notes')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class NoteController {
  constructor(private readonly noteService: NoteService) {}

  @Post()
  @ApiOperation({ summary: 'Create a note on an entity' })
  @ApiResponse({ status: 201, description: 'Note created successfully' })
  async create(@Request() req, @Body() dto: CreateNoteDto) {
    return this.noteService.create(
      {
        tenantId: req.user.tenantId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        content: dto.content,
        isInternal: dto.isInternal,
      },
      req.user.sub,
    );
  }

  @Get('entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get all notes for a specific entity' })
  @ApiResponse({ status: 200, description: 'Notes retrieved' })
  async findByEntity(
    @Request() req,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.noteService.findByEntity(req.user.tenantId, entityType, entityId);
  }

  @Get()
  @ApiOperation({ summary: 'List notes for tenant with filters' })
  async findAll(@Request() req, @Query() filters: NoteFilterDto) {
    return this.noteService.findByTenant(req.user.tenantId, filters);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get note by ID' })
  @ApiResponse({ status: 200, description: 'Note retrieved' })
  @ApiResponse({ status: 404, description: 'Note not found' })
  async findOne(@Param('id') id: string, @Request() req) {
    return this.noteService.findById(id, req.user.tenantId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a note' })
  async update(
    @Param('id') id: string,
    @Request() req,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.noteService.update(id, req.user.tenantId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a note' })
  @ApiResponse({ status: 204, description: 'Note deleted' })
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    await this.noteService.delete(id, req.user.tenantId);
  }
}