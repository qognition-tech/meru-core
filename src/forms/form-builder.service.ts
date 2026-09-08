import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  FormSchema,
  FormStatus,
  FormLayout,
} from './entities/form-schema.entity';
import { FormField, FieldType } from './entities/form-field.entity';
import {
  FormSubmission,
  SubmissionStatus,
} from './entities/form-submission.entity';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';
import { DocumentHubService } from '../documents/document-hub.service';
import { Document } from '../documents/entities/document.entity';
import { Actor, scopeOf } from '../common/access';

export interface FormDefinition {
  name: string;
  description?: string;
  entityType: string;
  layout: FormLayout;
  fields: Array<{
    key: string;
    label: string;
    type: FieldType;
    description?: string;
    placeholder?: string;
    order?: number;
    validation?: Record<string, any>;
    options?: Record<string, any>;
    config?: Record<string, any>;
    conditionalLogic?: Record<string, any>;
  }>;
  config?: Record<string, any>;
}

@Injectable()
export class FormBuilderService {
  private readonly logger = new Logger(FormBuilderService.name);

  constructor(
    @InjectRepository(FormSchema)
    private formSchemaRepo: Repository<FormSchema>,
    @InjectRepository(FormField)
    private formFieldRepo: Repository<FormField>,
    @InjectRepository(FormSubmission)
    private submissionRepo: Repository<FormSubmission>,
    private dataSource: DataSource,
    private searchService: SearchService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
    @Inject(forwardRef(() => DocumentHubService))
    private documentHubService: DocumentHubService,
  ) {}

  // ==================== FORM SCHEMA ====================

  async createForm(
    tenantId: string,
    definition: FormDefinition,
    userId: string,
  ): Promise<FormSchema> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Create form schema
      const schema = queryRunner.manager.create(FormSchema, {
        tenantId,
        name: definition.name,
        description: definition.description,
        entityType: definition.entityType,
        layout: definition.layout,
        version: 1,
        status: FormStatus.DRAFT,
        config: definition.config || {},
      });

      const savedSchema = await queryRunner.manager.save(schema);

      // Create fields
      for (const fieldDef of definition.fields) {
        const field = queryRunner.manager.create(FormField, {
          formSchemaId: savedSchema.id,
          key: fieldDef.key,
          label: fieldDef.label,
          type: fieldDef.type,
          description: fieldDef.description,
          placeholder: fieldDef.placeholder,
          order: fieldDef.order || 0,
          validation: fieldDef.validation || {},
          options: fieldDef.options || {},
          config: fieldDef.config || {},
          conditionalLogic: fieldDef.conditionalLogic,
        });
        await queryRunner.manager.save(field);
      }

      await queryRunner.commitTransaction();
      this.logger.log(`Form created: ${savedSchema.id}`);

      return this.getForm(savedSchema.id, tenantId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Tenant-scoped fetch. `tenantId` is required, not optional — same fix,
   * same reasoning, as `getSubmission` below: this was `findOne({ where: { id
   * } })` with no tenant filter at all, so any form schema in any tenant
   * resolved by id alone. RLS is verified enforced in production for this
   * table (`form_schemas` carries `rls=true, force=true`), so this is
   * defence-in-depth rather than the live cross-tenant leak an earlier report
   * claimed — but the belt-and-braces posture applies here exactly as it does
   * everywhere else this codebase touches regulated data.
   */
  async getForm(id: string, tenantId: string): Promise<FormSchema> {
    const form = await this.formSchemaRepo.findOne({
      where: { id, tenantId },
      relations: ['fields'],
    });

    if (!form) {
      throw new NotFoundException('Form not found');
    }

    return form;
  }

  async listForms(
    tenantId: string,
    entityType?: string,
    status?: FormStatus,
  ): Promise<FormSchema[]> {
    const where: any = { tenantId };
    if (entityType) where.entityType = entityType;
    if (status) where.status = status;

    return this.formSchemaRepo.find({
      where,
      relations: ['fields'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Bare update of a DRAFT form. Published (ACTIVE) forms are immutable by
   * design — live submissions reference their field set — so edits to a
   * published form must go through createNewVersion instead. This split is
   * the contract answer to the FE's "PUT /forms/:id or /forms/:id/version?"
   * question: PUT for drafts, version for anything already published.
   */
  async updateForm(
    id: string,
    tenantId: string,
    definition: Partial<FormDefinition>,
  ): Promise<FormSchema> {
    const form = await this.formSchemaRepo.findOne({
      where: { id, tenantId },
    });

    if (!form) {
      throw new NotFoundException('Form not found');
    }

    if (form.status !== FormStatus.DRAFT) {
      throw new ConflictException(
        'Published forms are immutable — create a new draft version via POST /forms/:id/version, edit that, then publish it.',
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (definition.name !== undefined) form.name = definition.name;
      if (definition.description !== undefined)
        form.description = definition.description;
      if (definition.layout !== undefined) form.layout = definition.layout;
      if (definition.config !== undefined) form.config = definition.config;
      await queryRunner.manager.save(form);

      // A fields array replaces the draft's field set wholesale — partial
      // field patches would need per-field identity the DTO doesn't carry.
      if (definition.fields !== undefined) {
        await queryRunner.manager.delete(FormField, { formSchemaId: form.id });
        for (const fieldDef of definition.fields) {
          const field = queryRunner.manager.create(FormField, {
            formSchemaId: form.id,
            key: fieldDef.key,
            label: fieldDef.label,
            type: fieldDef.type,
            description: fieldDef.description,
            placeholder: fieldDef.placeholder,
            order: fieldDef.order || 0,
            validation: fieldDef.validation || {},
            options: fieldDef.options || {},
            config: fieldDef.config || {},
            conditionalLogic: fieldDef.conditionalLogic,
          });
          await queryRunner.manager.save(field);
        }
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    return this.getForm(id, tenantId);
  }

  async publishForm(id: string, tenantId: string): Promise<FormSchema> {
    const form = await this.formSchemaRepo.findOne({
      where: { id, tenantId },
    });

    if (!form) {
      throw new NotFoundException('Form not found');
    }

    form.status = FormStatus.ACTIVE;
    await this.formSchemaRepo.save(form);

    return this.getForm(id, tenantId);
  }

  async createNewVersion(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<FormSchema> {
    // `getForm` is now tenant-scoped by its required `tenantId` argument —
    // same note as `getSubmission` — so the redundant `tenantId` equality
    // check that used to follow this is dead code and has been removed.
    const existingForm = await this.getForm(id, tenantId);

    // Archive old version
    existingForm.status = FormStatus.ARCHIVED;
    await this.formSchemaRepo.save(existingForm);

    // Create new version
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const newSchema = queryRunner.manager.create(FormSchema, {
        tenantId,
        name: existingForm.name,
        description: existingForm.description,
        entityType: existingForm.entityType,
        layout: existingForm.layout,
        version: existingForm.version + 1,
        status: FormStatus.DRAFT,
        config: existingForm.config,
      });

      const savedSchema = await queryRunner.manager.save(newSchema);

      // Copy fields
      for (const field of existingForm.fields) {
        const newField = queryRunner.manager.create(FormField, {
          formSchemaId: savedSchema.id,
          key: field.key,
          label: field.label,
          type: field.type,
          description: field.description,
          placeholder: field.placeholder,
          order: field.order,
          validation: field.validation,
          options: field.options,
          config: field.config,
          conditionalLogic: field.conditionalLogic,
        });
        await queryRunner.manager.save(newField);
      }

      await queryRunner.commitTransaction();
      this.logger.log(
        `Form version ${savedSchema.version} created: ${savedSchema.id}`,
      );

      return this.getForm(savedSchema.id, tenantId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ==================== FORM SUBMISSIONS ====================

  async createSubmission(
    formSchemaId: string,
    tenantId: string,
    userId: string,
    data: Record<string, any>,
    entityId?: string,
  ): Promise<FormSubmission> {
    const form = await this.getForm(formSchemaId, tenantId);

    // Validate data
    const validationErrors = this.validateData(data, form.fields);

    const submission = this.submissionRepo.create({
      tenantId,
      formSchemaId,
      entityId,
      data,
      validationErrors,
      status:
        validationErrors.length > 0
          ? SubmissionStatus.DRAFT
          : SubmissionStatus.SUBMITTED,
      submittedBy: userId,
      submittedAt: validationErrors.length > 0 ? null : new Date(),
      history: [
        {
          timestamp: new Date(),
          action: 'created',
          userId,
          changes: data,
        },
      ],
    });

    const saved = await this.submissionRepo.save(submission);
    this.logger.log(`Submission created: ${saved.id}`);

    return this.getSubmission(saved.id, tenantId);
  }

  /**
   * Tenant-scoped fetch. `tenantId` is required, not optional — this used to
   * be `findOne({ where: { id } })` with **no tenant filter at all**, so any
   * submission in any tenant resolved by id alone: a `client` in one tenant
   * who knew or guessed a submission UUID could read another tenant's form
   * data outright. An optional tenant parameter a caller could forget to pass
   * would have been the same bug with extra steps — the compiler now finds
   * every call site instead, the same fix `CrmService.getEntity` made for
   * `/crm/entities`.
   *
   * This is tenant isolation only, not user-scoping. Whether a `client`-role
   * caller may reach a submission that is not theirs (as opposed to not their
   * tenant's) is a different rule — it narrows *inside* one tenant, tenant
   * isolation narrows *across* tenants — and it lives one layer up, in
   * `FormController.assertSubmissionOwnership`, exactly the split
   * `CrmAccessService`/`DocumentAccessService` make between tenant scope and
   * ownership.
   */
  async getSubmission(id: string, tenantId: string): Promise<FormSubmission> {
    const submission = await this.submissionRepo.findOne({
      where: { id, tenantId },
      relations: ['formSchema', 'formSchema.fields'],
    });

    if (!submission) {
      throw new NotFoundException('Submission not found');
    }

    return submission;
  }

  async listSubmissions(
    tenantId: string,
    formSchemaId?: string,
    status?: SubmissionStatus,
    entityId?: string,
    /**
     * Optional, unlike the pattern `CrmAccessService.applyScope` sets, because
     * one caller outside `src/forms/*` — `AiService`'s smart-search branch —
     * calls this with only a `tenantId`, aggregating tenant-wide the same way
     * its CRM and document branches next to it do (those use `SYSTEM_ACTOR`).
     * `ai.service.ts` is out of this hardening pass's file ownership, so
     * threading a real actor through that call is a handoff, not done here —
     * until then a `client`-role caller reaching AI smart-search still sees
     * every applicant's form submissions in those results, same as before
     * this change. Every caller inside this module (`FormController`) passes
     * one.
     */
    actor?: Actor,
  ): Promise<FormSubmission[]> {
    const where: any = { tenantId };
    if (formSchemaId) where.formSchemaId = formSchemaId;
    if (status) where.status = status;
    if (entityId) where.entityId = entityId;
    // `own` scope: a client sees only what they submitted. Applied in the
    // query, not filtered after the fact in the controller, so every future
    // caller of this method inherits it — see the note on `actor` above for
    // the one caller that does not yet supply one.
    if (actor && scopeOf(actor) === 'own') where.submittedBy = actor.id;

    return this.submissionRepo.find({
      where,
      relations: ['formSchema'],
      order: { createdAt: 'DESC' },
    });
  }

  async updateSubmission(
    id: string,
    tenantId: string,
    userId: string,
    data: Record<string, any>,
  ): Promise<FormSubmission> {
    // `getSubmission` is tenant-scoped by its required `tenantId` argument —
    // this 404s rather than yielding another tenant's row, so the explicit
    // `tenantId` comparison this method used to make afterwards is dead code
    // now and has been removed.
    const submission = await this.getSubmission(id, tenantId);

    // Validate data
    const validationErrors = this.validateData(
      data,
      submission.formSchema.fields,
    );

    // Merge data
    const newData = { ...submission.data, ...data };

    // Add to history
    submission.history.push({
      timestamp: new Date(),
      action: 'updated',
      userId,
      changes: data,
    });

    await this.submissionRepo.update(id, {
      data: newData,
      validationErrors,
      history: submission.history,
    });

    return this.getSubmission(id, tenantId);
  }

  async submitForm(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<FormSubmission> {
    // See the note on `updateSubmission` — `getSubmission` already 404s on a
    // wrong-tenant id, so the redundant `tenantId` check is gone.
    const submission = await this.getSubmission(id, tenantId);

    if (submission.validationErrors.length > 0) {
      throw new BadRequestException('Form has validation errors');
    }

    submission.status = SubmissionStatus.SUBMITTED;
    submission.submittedAt = new Date();
    submission.history.push({
      timestamp: new Date(),
      action: 'submitted',
      userId,
      changes: {},
    });

    await this.submissionRepo.save(submission);
    return this.getSubmission(id, tenantId);
  }

  async reviewSubmission(
    id: string,
    tenantId: string,
    userId: string,
    status: 'approved' | 'rejected',
    notes?: string,
  ): Promise<FormSubmission> {
    // See the note on `updateSubmission` — `getSubmission` already 404s on a
    // wrong-tenant id, so the redundant `tenantId` check is gone. Staff-only
    // (`@Roles(STAFF, FIRM_ADMIN)` on the controller route) is unaffected: this
    // is tenant isolation, not the `own`-scope ownership check, so a staff
    // reviewer still reaches any applicant's submission in their own tenant.
    const submission = await this.getSubmission(id, tenantId);

    submission.status =
      status === 'approved'
        ? SubmissionStatus.APPROVED
        : SubmissionStatus.REJECTED;
    submission.reviewedBy = userId;
    submission.reviewedAt = new Date();
    submission.reviewNotes = notes || null;
    submission.history.push({
      timestamp: new Date(),
      action: status,
      userId,
      changes: { notes },
    });

    await this.submissionRepo.save(submission);

    // Index submission after approval
    if (status === 'approved') {
      await this.indexSubmission(submission);
    }

    return this.getSubmission(id, tenantId);
  }

  // ==================== SEARCH & AI INTEGRATION ====================

  async indexSubmission(submission: FormSubmission): Promise<void> {
    try {
      const searchableData = {
        tenantId: submission.tenantId,
        searchableType: 'form_submission',
        searchableId: submission.id,
        title: `Form Submission: ${submission.formSchema?.name || 'Unknown Form'}`,
        content: JSON.stringify(submission.data),
        metadata: {
          formSchemaId: submission.formSchemaId,
          entityId: submission.entityId,
          status: submission.status,
          submittedBy: submission.submittedBy,
          submittedAt: submission.submittedAt,
        },
      };

      await this.searchService.indexEntityData(searchableData);
      this.logger.debug(`Form submission indexed: ${submission.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to index form submission: ${submission.id}`,
        error,
      );
    }
  }

  async searchSubmissions(
    tenantId: string,
    query: string,
    limit: number = 20,
  ): Promise<any[]> {
    return this.searchService.search(tenantId, query, limit);
  }

  // Not wired to any route today (`grep -rn extractFormDataWithAI src`
  // finds only this definition) — `tenantId` added anyway so this keeps
  // compiling against `getForm`'s now-required tenant scope rather than
  // becoming the next unscoped call site the moment a controller reaches it.
  async extractFormDataWithAI(
    documentContent: string,
    formSchemaId: string,
    tenantId: string,
  ): Promise<any> {
    try {
      const form = await this.getForm(formSchemaId, tenantId);

      const fieldNames = form.fields.map((f) => f.key).join(', ');

      const extraction = await this.aiService.extractFromDocument(
        documentContent,
        form.fields.map((f) => f.key),
      );

      return {
        success: true,
        extractedData: JSON.parse(extraction.result),
        confidence: 0.85, // Simplified confidence score
      };
    } catch (error) {
      this.logger.error(
        `Failed to extract form data with AI: ${error.message}`,
      );
      return {
        success: false,
        extractedData: null,
        error: error.message,
      };
    }
  }

  // Same note as `extractFormDataWithAI` above — not wired to any route today.
  async validateFormWithAI(
    formData: Record<string, any>,
    formSchemaId: string,
    tenantId: string,
  ): Promise<any> {
    try {
      const form = await this.getForm(formSchemaId, tenantId);

      const validationRules = form.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        validation: f.validation,
      }));

      const validation = await this.aiService.validateFormData(
        formData,
        validationRules,
      );

      return {
        success: true,
        validationResult: JSON.parse(validation.result),
      };
    } catch (error) {
      this.logger.error(`Failed to validate form with AI: ${error.message}`);
      return {
        success: false,
        validationResult: null,
        error: error.message,
      };
    }
  }

  // ==================== VALIDATION ====================

  private validateData(
    data: Record<string, any>,
    fields: FormField[],
  ): Array<{ field: string; message: string; type: string }> {
    const errors: Array<{ field: string; message: string; type: string }> = [];

    for (const field of fields) {
      const value = data[field.key];
      const validation = field.validation;

      // Required check
      if (
        validation?.required &&
        (value === undefined || value === null || value === '')
      ) {
        errors.push({
          field: field.key,
          message: `${field.label} is required`,
          type: 'required',
        });
        continue;
      }

      if (value === undefined || value === null) continue;

      // Min/Max length for strings
      if (typeof value === 'string') {
        if (validation?.minLength && value.length < validation.minLength) {
          errors.push({
            field: field.key,
            message: `${field.label} must be at least ${validation.minLength} characters`,
            type: 'minLength',
          });
        }
        if (validation?.maxLength && value.length > validation.maxLength) {
          errors.push({
            field: field.key,
            message: `${field.label} must be at most ${validation.maxLength} characters`,
            type: 'maxLength',
          });
        }
      }

      // Min/Max for numbers
      if (typeof value === 'number') {
        if (validation?.min !== undefined && value < validation.min) {
          errors.push({
            field: field.key,
            message: `${field.label} must be at least ${validation.min}`,
            type: 'min',
          });
        }
        if (validation?.max !== undefined && value > validation.max) {
          errors.push({
            field: field.key,
            message: `${field.label} must be at most ${validation.max}`,
            type: 'max',
          });
        }
      }

      // Pattern validation
      if (validation?.pattern && typeof value === 'string') {
        const regex = new RegExp(validation.pattern);
        if (!regex.test(value)) {
          errors.push({
            field: field.key,
            message:
              validation.patternMessage || `${field.label} format is invalid`,
            type: 'pattern',
          });
        }
      }
    }

    return errors;
  }

  // ==================== RENDER HELPERS ====================

  async renderForm(formSchemaId: string, tenantId: string): Promise<any> {
    const form = await this.getForm(formSchemaId, tenantId);

    return {
      id: form.id,
      name: form.name,
      description: form.description,
      layout: form.layout,
      version: form.version,
      config: form.config,
      fields: form.fields
        .sort((a, b) => a.order - b.order)
        .map((field) => ({
          id: field.id,
          key: field.key,
          label: field.label,
          type: field.type,
          description: field.description,
          placeholder: field.placeholder,
          validation: field.validation,
          options: field.options,
          config: field.config,
          conditionalLogic: field.conditionalLogic,
        })),
    };
  }

  // ==================== DOCUMENT INTEGRATION ====================

  async getSubmissionDocuments(
    tenantId: string,
    submissionId: string,
  ): Promise<Document[]> {
    return this.documentHubService.getFormSubmissionDocuments(
      tenantId,
      submissionId,
    );
  }

  async attachDocumentToSubmission(
    tenantId: string,
    submissionId: string,
    documentId: string,
    userId: string,
  ): Promise<Document> {
    // Confirms the submission exists in this tenant before attaching — see
    // `getSubmission`'s own note on why `tenantId` is required. The redundant
    // post-fetch tenant comparison this method used to make is gone; the
    // return value is not otherwise needed here.
    await this.getSubmission(submissionId, tenantId);

    return this.documentHubService.attachDocumentToEntity(
      documentId,
      'form_submission',
      submissionId,
      userId,
    );
  }

  async processSubmissionDocuments(
    tenantId: string,
    submissionId: string,
    documentIds: string[],
  ): Promise<any> {
    const results = await Promise.all(
      documentIds.map(async (docId) => {
        try {
          // Analyze document with AI
          const analysis = await this.documentHubService.analyzeDocument(docId);
          return { documentId: docId, ...analysis };
        } catch (error) {
          this.logger.error(`Failed to process document ${docId}:`, error);
          return { documentId: docId, success: false, error: error.message };
        }
      }),
    );

    // Update submission with document analysis
    const submission = await this.getSubmission(submissionId, tenantId);
    submission.metadata = {
      ...submission.metadata,
      documentAnalysis: results,
    };

    await this.submissionRepo.save(submission);

    return {
      submissionId,
      processedDocuments: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  async extractDataFromSubmissionDocuments(
    tenantId: string,
    submissionId: string,
    extractionSchema: Record<string, any>,
  ): Promise<any> {
    const documents = await this.getSubmissionDocuments(tenantId, submissionId);

    const results = await Promise.all(
      documents.map(async (doc) => {
        try {
          return await this.documentHubService.extractDocumentData(
            doc.id,
            extractionSchema,
          );
        } catch (error) {
          this.logger.error(
            `Failed to extract data from document ${doc.id}:`,
            error,
          );
          return { documentId: doc.id, success: false, error: error.message };
        }
      }),
    );

    // Merge extracted data
    const extractedData = results
      .filter((r) => r.success)
      .reduce((acc, r) => ({ ...acc, ...r.extractedData }), {});

    return {
      submissionId,
      processedDocuments: results.length,
      successful: results.filter((r) => r.success).length,
      extractedData,
    };
  }

  async searchSubmissionDocuments(
    tenantId: string,
    submissionId: string,
    query: string,
  ): Promise<any[]> {
    return this.documentHubService.searchDocuments(tenantId, query, {
      entityType: 'form_submission',
      entityId: submissionId,
    });
  }
}
