import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FormBuilderService } from './form-builder.service';
import { PolicyGuard } from '../iam/guards/policy.guard';

@ApiTags('forms')
@Controller('forms')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class FormController {
  constructor(private formService: FormBuilderService) {}

  // ==================== FORM SCHEMAS ====================

  @Post()
  @ApiOperation({ summary: 'Create a new form schema' })
  @ApiResponse({ status: 201, description: 'Form created successfully' })
  async createForm(@Request() req, @Body() dto: any) {
    const form = await this.formService.createForm(
      req.user.tenantId,
      dto,
      req.user.id,
    );
    return form;
  }

  @Get()
  @ApiOperation({ summary: 'List all forms' })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'Forms retrieved' })
  async listForms(
    @Request() req,
    @Query('entityType') entityType?: string,
    @Query('status') status?: string,
  ) {
    const forms = await this.formService.listForms(
      req.user.tenantId,
      entityType,
      status as any,
    );
    return forms;
  }

  // ── Submission reads ──────────────────────────────────────────────────────
  //
  // These MUST stay above `@Get(':id')`. Nest matches in declaration order, so
  // with `:id` first the literal path `/forms/submissions` was swallowed by it
  // and resolved as `getForm('submissions')` — which, thanks to ParseUUIDPipe,
  // surfaced as a 400 about a malformed UUID rather than anything resembling
  // the real problem.

  @Get('submissions')
  @ApiOperation({ summary: 'List form submissions' })
  @ApiQuery({ name: 'formSchemaId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiResponse({ status: 200, description: 'Submissions retrieved' })
  async listSubmissions(
    @Request() req,
    @Query('formSchemaId') formSchemaId?: string,
    @Query('status') status?: string,
    @Query('entityId') entityId?: string,
  ) {
    return this.formService.listSubmissions(
      req.user.tenantId,
      formSchemaId,
      status as any,
      entityId,
    );
  }

  @Get('submissions/:submissionId')
  @ApiOperation({ summary: 'Get submission by ID' })
  @ApiResponse({ status: 200, description: 'Submission retrieved' })
  async getSubmission(
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    return this.formService.getSubmission(submissionId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get form by ID' })
  @ApiResponse({ status: 200, description: 'Form retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getForm(@Param('id', ParseUUIDPipe) id: string) {
    const form = await this.formService.getForm(id);
    return form;
  }

  @Get(':id/render')
  @ApiOperation({ summary: 'Get form rendered for UI' })
  @ApiResponse({ status: 200, description: 'Form rendered' })
  async renderForm(@Param('id', ParseUUIDPipe) id: string) {
    const form = await this.formService.renderForm(id);
    return form;
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish a form' })
  @ApiResponse({ status: 200, description: 'Form published' })
  async publishForm(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    const form = await this.formService.publishForm(id, req.user.tenantId);
    return form;
  }

  @Post(':id/version')
  @ApiOperation({ summary: 'Create new version of form' })
  @ApiResponse({ status: 201, description: 'New version created' })
  async createNewVersion(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const form = await this.formService.createNewVersion(
      id,
      req.user.tenantId,
      req.user.id,
    );
    return form;
  }

  // ==================== FORM SUBMISSIONS ====================

  @Post(':id/submissions')
  @ApiOperation({ summary: 'Create a form submission' })
  @ApiResponse({ status: 201, description: 'Submission created' })
  async createSubmission(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { data: Record<string, any>; entityId?: string },
  ) {
    const submission = await this.formService.createSubmission(
      id,
      req.user.tenantId,
      req.user.id,
      dto.data,
      dto.entityId,
    );
    return submission;
  }

  @Put('submissions/:submissionId')
  @ApiOperation({ summary: 'Update a submission' })
  @ApiResponse({ status: 200, description: 'Submission updated' })
  async updateSubmission(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: { data: Record<string, any> },
  ) {
    const submission = await this.formService.updateSubmission(
      submissionId,
      req.user.tenantId,
      req.user.id,
      dto.data,
    );
    return submission;
  }

  @Post('submissions/:submissionId/submit')
  @ApiOperation({ summary: 'Submit a form' })
  @ApiResponse({ status: 200, description: 'Form submitted' })
  async submitForm(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    const submission = await this.formService.submitForm(
      submissionId,
      req.user.tenantId,
      req.user.id,
    );
    return submission;
  }

  @Post('submissions/:submissionId/review')
  @ApiOperation({ summary: 'Review a submission (approve/reject)' })
  @ApiResponse({ status: 200, description: 'Submission reviewed' })
  async reviewSubmission(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: { status: 'approved' | 'rejected'; notes?: string },
  ) {
    const submission = await this.formService.reviewSubmission(
      submissionId,
      req.user.tenantId,
      req.user.id,
      dto.status,
      dto.notes,
    );
    return submission;
  }
}
