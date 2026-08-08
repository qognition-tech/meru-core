import { z } from 'zod';

// ── Primitive reusables ────────────────────────────────────────────────────

const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be semver x.y.z');

const HttpUrl = z.string().url();

const LocaleCode = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'must be BCP-47 like en or en-AU');

// ── Form field definition ──────────────────────────────────────────────────

const FormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum([
    'text', 'email', 'phone', 'date', 'select', 'multiselect',
    'file', 'checkbox', 'textarea', 'number', 'currency', 'country',
  ]),
  required: z.boolean().default(false),
  validation: z.object({
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  }).optional(),
  helpText: z.string().optional(),
  dependsOn: z.object({ field: z.string(), value: z.unknown() }).optional(),
});

// ── Workflow step ──────────────────────────────────────────────────────────

const WorkflowStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['form', 'review', 'document', 'payment', 'decision', 'notification', 'api_call']),
  assignedRole: z.string().optional(),
  slaHours: z.number().positive().optional(),
  formFields: z.array(FormFieldSchema).optional(),
  transitions: z.array(z.object({
    to: z.string(),
    label: z.string(),
    condition: z.string().optional(),
  })).optional(),
  requiredDocuments: z.array(z.string()).optional(),
  apiAction: z.object({
    adapterId: z.string(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

// ── Regulator / government endpoint ───────────────────────────────────────

const RegulatorSchema = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string().length(2),
  baseUrl: HttpUrl.optional(),
  authMethod: z.enum(['api_key', 'oauth2', 'mtls', 'none']).default('none'),
  adapterId: z.string(),
  sandboxUrl: HttpUrl.optional(),
  documentation: HttpUrl.optional(),
});

// ── KPI definition ────────────────────────────────────────────────────────

const KpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.enum(['count', 'percentage', 'days', 'hours', 'currency', 'score']),
  target: z.number().optional(),
  alert: z.object({ threshold: z.number(), direction: z.enum(['above', 'below']) }).optional(),
});

// ── Role definition ───────────────────────────────────────────────────────

const RoleSchema = z.object({
  key: z.string(),
  label: z.string(),
  permissions: z.array(z.string()),
  inherits: z.array(z.string()).optional(),
});

// ── Document type ─────────────────────────────────────────────────────────

const DocumentTypeSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean().default(false),
  acceptedFormats: z.array(z.string()),
  maxSizeMb: z.number().positive().default(10),
  aiExtraction: z.object({
    enabled: z.boolean().default(false),
    fields: z.array(z.string()).optional(),
  }).optional(),
  fraudChecks: z.object({
    exifAnalysis: z.boolean().default(false),
    duplicateHash: z.boolean().default(false),
    fontConsistency: z.boolean().default(false),
  }).optional(),
});

// ── Screening configuration ────────────────────────────────────────────────

const ScreeningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  lists: z.array(z.enum(['ofac', 'eu', 'un', 'uk_hmt', 'uae_local', 'custom'])),
  threshold: z.number().min(0).max(1).default(0.85),
  autoEscalate: z.boolean().default(true),
  pepCheck: z.boolean().default(false),
  adverseMedia: z.boolean().default(false),
});

// ── Compliance rules ──────────────────────────────────────────────────────

const ComplianceRulesSchema = z.object({
  dataResidency: z.string().length(2).optional(),
  retentionYears: z.number().positive().optional(),
  encryptionRequired: z.boolean().default(true),
  auditRequired: z.boolean().default(true),
  regulatoryFrameworks: z.array(z.string()).optional(),
  reportingObligations: z.array(z.object({
    trigger: z.string(),
    reportType: z.string(),
    deadline: z.string(),
    regulatorId: z.string(),
  })).optional(),
});

// ── AI prompt library ─────────────────────────────────────────────────────

/**
 * The vertical's prompt library. This is Layer 4 for the AI gateway.
 *
 * It lives in the pack rather than in `ai_prompts` rows because a per-tenant
 * table has to be seeded per tenant, and it was not: `GET /ai/prompts`
 * returned `[]` on production and `POST /ai/execute` answered every request
 * with `500 Prompt not found`, for every tenant, while the route was recorded
 * as shipped. A pack ships with the vertical, so a new tenant inherits a
 * working library the moment it is pinned — nothing to remember, nothing to
 * seed. `ai_prompts` remains as the per-tenant *override* layer.
 *
 * `requireCitations` defaults true: CLAUDE.md §6.3 makes citation enforcement
 * a condition of shipping AI at all, so an author has to opt a prompt *out*
 * deliberately rather than forget to opt it in.
 */
const PromptSchema = z.object({
  key: z.string().min(1),
  category: z.enum([
    'entity_analysis',
    'document_processing',
    'workflow_decision',
    'data_extraction',
    'validation',
  ]),
  description: z.string().optional(),
  /**
   * Supports `{{INPUT}}`, `{{VERTICAL}}`, `{{TENANT_ID}}` and any
   * `{{UPPERCASED_CONTEXT_KEY}}` the caller passes in `context`.
   */
  prompt: z.string().min(20),
  provider: z.enum(['openai', 'anthropic', 'local']).default('openai'),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  requireCitations: z.boolean().default(true),
  /**
   * The one to use when a caller names a category but no key. Exactly one per
   * category should set it; the resolver takes the first and is deterministic
   * about which, but two defaults in one category is an authoring error.
   */
  isCategoryDefault: z.boolean().default(false),
});

// ── Messaging: templates and sequences ────────────────────────────────────

/**
 * Outbound message templates, same reasoning as the prompt library above —
 * `notification_templates` was also empty in production, which made every
 * "email template" feature in both specs non-functional regardless of whether
 * a mail transport was configured.
 */
const MessageTemplateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  channel: z.enum(['email', 'sms', 'push', 'in_app']).default('email'),
  /** Ignored for sms/push; kept required for email so none ships subject-less. */
  subject: z.string().default(''),
  /** Plain-text body. `{{variable}}` placeholders. */
  body: z.string().min(1),
  htmlBody: z.string().optional(),
  /**
   * Declared placeholder names. Used to tell a caller which variables a
   * template expects instead of silently rendering `{{firstName}}` to a client.
   */
  variables: z.array(z.string()).default([]),
});

// ── Top-level config pack schema ──────────────────────────────────────────

export const ConfigPackSchema = z.object({
  // `<iso2>-<vertical>`, e.g. au-immigration. Matches the pattern in
  // config-pack.schema.json and the codes the packs on disk actually declare —
  // a previous slash-separated regex here rejected every pack at boot, leaving
  // config_packs empty. The slash form is the *directory* layout (au/immigration.json),
  // not the pack code.
  code: z
    .string()
    .regex(/^[a-z]{2}-[a-z_]+$/, 'must be country-vertical like au-immigration'),
  name: z.string().min(3),
  description: z.string().optional(),
  version: SemVer,
  vertical: z.enum(['immigration', 'banking', 'health', 'tax', 'labour', 'education', 'legal']),
  country: z.string().length(2),
  locales: z.array(LocaleCode).min(1),

  regulators: z.array(RegulatorSchema).optional(),
  roles: z.array(RoleSchema).optional(),
  documentTypes: z.array(DocumentTypeSchema).optional(),
  workflows: z.array(z.object({
    id: z.string(),
    name: z.string(),
    entityType: z.string(),
    steps: z.array(WorkflowStepSchema),
  })).optional(),
  screening: ScreeningConfigSchema.optional(),
  compliance: ComplianceRulesSchema.optional(),
  kpis: z.array(KpiSchema).optional(),

  /** The vertical's AI prompt library — see PromptSchema. */
  prompts: z.array(PromptSchema).optional(),

  /**
   * Outbound messaging. `sequences[]` (multi-step automation) is the next
   * addition here; templates land first because they are what the empty
   * `notification_templates` table was blocking.
   */
  messaging: z
    .object({
      templates: z.array(MessageTemplateSchema).default([]),
    })
    .optional(),

  /**
   * Per-entity-type vocabulary: what core stores as `knowledge_article` is
   * rendered as "Knowledge Base" with these columns, status words and form
   * controls. This is Layer 4 doing its job (CLAUDE.md §4) — the UI reads it
   * instead of hardcoding a field list per page.
   *
   * Fields are intentionally loose: a vertical may need control types this
   * schema has never heard of, and a strict union would mean editing core
   * every time a pack author invents one. The `type` string is validated by
   * the renderer, which falls back to a text input for anything unknown.
   */
  entityTypes: z.array(z.object({
    type: z.string(),
    label: z.string(),
    pluralLabel: z.string().optional(),
    module: z.string().optional(),
    workable: z.boolean().optional(),
    statusLabels: z.record(z.string(), z.string()).optional(),
    fields: z.array(z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      required: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      multiple: z.boolean().optional(),
      default: z.unknown().optional(),
      formula: z.string().optional(),
    })).default([]),
  })).optional(),

  defaults: z.record(z.string(), z.unknown()).optional(),
  uiConfig: z.object({
    primaryColor: z.string().optional(),
    logo: HttpUrl.optional(),
    supportEmail: z.string().email().optional(),
    termsUrl: HttpUrl.optional(),
    helpUrl: HttpUrl.optional(),
  }).optional(),
  metadata: z.object({
    author: z.string().optional(),
    lastReviewedAt: z.string().datetime().optional(),
    regulatoryReference: z.string().optional(),
  }).optional(),
});

export type ConfigPackDefinition = z.infer<typeof ConfigPackSchema>;

/** Section types the core modules read at runtime. */
export type PackPrompt = z.infer<typeof PromptSchema>;
export type PackMessageTemplate = z.infer<typeof MessageTemplateSchema>;

export function validateConfigPack(raw: unknown): ConfigPackDefinition {
  return ConfigPackSchema.parse(raw);
}

export function safeValidateConfigPack(raw: unknown): {
  success: true; data: ConfigPackDefinition;
} | {
  success: false; error: z.ZodError;
} {
  const result = ConfigPackSchema.safeParse(raw);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}
