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
