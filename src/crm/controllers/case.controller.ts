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
import { CaseService } from '../services/case.service';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import {
  CreateCaseDto,
  UpdateCaseDto,
  TransitionCaseDto,
  CaseFilterDto,
} from '../dto/case.dto';

@Controller('crm/cases')
@ApiTags('CRM / Cases')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class CaseController {
  constructor(private readonly caseService: CaseService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new case' })
  @ApiResponse({ status: 201, description: 'Case created successfully' })
  async create(@Request() req, @Body() dto: CreateCaseDto) {
    return this.caseService.create(
      {
        tenantId: req.user.tenantId,
        title: dto.title,
        description: dto.description,
        caseType: dto.caseType,
        priority: dto.priority,
        assignedTo: dto.assignedTo,
        caseData: dto.caseData,
        metadata: dto.metadata,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      req.user.sub,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List cases for tenant with filters' })
  @ApiResponse({ status: 200, description: 'Cases retrieved successfully' })
  async findAll(@Request() req, @Query() filters: CaseFilterDto) {
    return this.caseService.findByTenant(req.user.tenantId, filters);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get case by ID' })
  @ApiResponse({ status: 200, description: 'Case retrieved' })
  @ApiResponse({ status: 404, description: 'Case not found' })
  async findOne(@Param('id') id: string, @Request() req) {
    return this.caseService.findById(id, req.user.tenantId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update case details' })
  @ApiResponse({ status: 200, description: 'Case updated' })
  async update(
    @Param('id') id: string,
    @Request() req,
    @Body() dto: UpdateCaseDto,
  ) {
    return this.caseService.update(id, req.user.tenantId, {
      title: dto.title,
      description: dto.description,
      caseType: dto.caseType,
      priority: dto.priority,
      assignedTo: dto.assignedTo,
      caseData: dto.caseData,
      metadata: dto.metadata,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
    });
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition case status (e.g. open → in_progress)' })
  @ApiResponse({ status: 200, description: 'Status transitioned' })
  async transition(
    @Param('id') id: string,
    @Request() req,
    @Body() dto: TransitionCaseDto,
  ) {
    return this.caseService.transitionStatus(id, req.user.tenantId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a case' })
  @ApiResponse({ status: 204, description: 'Case deleted' })
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    await this.caseService.delete(id, req.user.tenantId);
  }
}
