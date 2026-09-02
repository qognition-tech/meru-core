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
  NotFoundException,
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
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { Actor, scopeOf } from '../common/access';
import { CreateFormDto } from './dto/create-form.dto';
import { UpdateFormDto } from './dto/update-form.dto';
import type { FormDefinition } from './form-builder.service';
import { UserPayload } from '../common/types';

@ApiTags('forms')
@Controller('forms')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class FormController {
  constructor(private formService: FormBuilderService) {}

  /**
   * `Actor` is deliberately not `UserPayload` — see its own doc comment.
   * Copied from `CrmController.actorFrom`.
   */
  private actorFrom(user: UserPayload): Actor {
    return { id: user.id, roles: user.roles ?? [] };
  }

  /**
   * User-scoping for a submission already confirmed to be in this caller's
   * tenant — `FormBuilderService.getSubmission` now takes `tenantId` as a
   * required parameter and 404s on any submission outside it, so the tenant
   * half of what this method used to compensate for is fixed at the source
   * and has been removed from here.
   *
   * What is left is a different rule, not tenant isolation: a `client`-role
   * caller (`scopeOf(actor) === 'own'`) may only reach a submission they
   * themselves submitted. That narrows *inside* one tenant rather than across
   * tenants, so it belongs at this layer — the same split
   * `CrmAccessService`/`DocumentAccessService` make between tenant scope and
   * ownership. 404, not 403: a submission that is not this caller's is not
   * confirmed to exist for them.
   */
  private assertSubmissionOwnership(
    submission: { submittedBy: string },
    actor: Actor,
  ): void {
    if (scopeOf(actor) === 'own' && submission.submittedBy !== actor.id) {
      throw new NotFoundException('Submission not found');
    }
  }

  // ==================== FORM SCHEMAS ====================

  @Post()
  @ApiOperation({ summary: 'Create a new form schema' })
  @ApiResponse({ status: 201, description: 'Form created successfully' })
  async createForm(@Request() req, @Body() dto: CreateFormDto) {
    // The DTO guarantees name, entityType, layout and a fields array. The
    // inner field vocabulary is the vertical's, supplied by a config pack, so
    // core validates the envelope and lets FORM interpret the contents
    // (CLAUDE.md §2 row 7).
    const form = await this.formService.createForm(
      req.user.tenantId,
      dto as unknown as FormDefinition,
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
  @ApiOperation({
    summary: 'List form submissions',
    description:
      "A `client` sees only submissions they submitted — `FormBuilderService.listSubmissions` " +
      'narrows to `submittedBy` in the query itself for `own` scope, rather ' +
      "than reaching into another applicant's intake data and filtering afterwards.",
  })
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
    // `FormBuilderService.listSubmissions` now applies `own`-scope narrowing
    // in the query itself, so the in-process filter this route used to do
    // after the fact is redundant and has been removed.
    return this.formService.listSubmissions(
      req.user.tenantId,
      formSchemaId,
      status as any,
      entityId,
      this.actorFrom(req.user),
    );
  }

  @Get('submissions/:submissionId')
  @ApiOperation({ summary: 'Get submission by ID' })
  @ApiResponse({ status: 200, description: 'Submission retrieved' })
  @ApiResponse({ status: 404, description: 'Not found, or not this caller\'s' })
  async getSubmission(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    const submission = await this.formService.getSubmission(
      submissionId,
      req.user.tenantId,
    );
    this.assertSubmissionOwnership(submission, this.actorFrom(req.user));
    return submission;
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

  @Put(':id')
  @ApiOperation({ summary: 'Update a DRAFT form in place' })
  @ApiResponse({ status: 200, description: 'Form updated' })
  @ApiResponse({
    status: 409,
    description:
      'Form is published — create a new version via POST /forms/:id/version',
  })
  async updateForm(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateFormDto,
  ) {
    return this.formService.updateForm(
      id,
      req.user.tenantId,
      dto as unknown as Partial<FormDefinition>,
    );
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
  @ApiResponse({ status: 404, description: 'Not found, or not this caller\'s' })
  async updateSubmission(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: { data: Record<string, any> },
  ) {
    // `FormBuilderService.updateSubmission` is tenant-scoped but not
    // user-scoped — see `assertSubmissionOwnership`.
    const existing = await this.formService.getSubmission(
      submissionId,
      req.user.tenantId,
    );
    this.assertSubmissionOwnership(existing, this.actorFrom(req.user));
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
  @ApiResponse({ status: 404, description: 'Not found, or not this caller\'s' })
  async submitForm(
    @Request() req,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    const existing = await this.formService.getSubmission(
      submissionId,
      req.user.tenantId,
    );
    this.assertSubmissionOwnership(existing, this.actorFrom(req.user));
    const submission = await this.formService.submitForm(
      submissionId,
      req.user.tenantId,
      req.user.id,
    );
    return submission;
  }

  @Post('submissions/:submissionId/review')
  @Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)
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
