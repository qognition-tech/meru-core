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

const RegulatorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.string().length(2),
    baseUrl: HttpUrl.optional(),
    authMethod: z.enum(['api_key', 'oauth2', 'mtls', 'none']).default('none'),
    /**
     * The INT adapter that talks to this regulator. Required only when
     * `availability` is `adapter`; see below.
     */
    adapterId: z.string().optional(),
    /**
     * Whether this regulator can actually be reached today.
     *
     * Added because both packs declared regulators with `adapterId` values that
     * matched no adapter in `src/integrations/adapters/` — `au-vevo`,
     * `uae-cbuae`, `refinitiv-worldcheck`, `dowjones-rnc`, `finacle-core`,
     * `uae-local-sanctions`. Two of those (`uae-cbuae`) were named by live
     * workflow steps, so the step would resolve `undefined` and fail as a
     * missing capability rather than as a broken reference.
     *
     * Most of them were never bugs of intent: WorldCheck, Dow Jones and Finacle
     * are real integrations that cannot exist in code until someone signs a
     * contract. The mistake was expressing "planned" as a pointer to nothing.
     * They are now declared honestly, which also lets a UI say "requires a
     * licence" instead of showing a connector that silently does nothing.
     */
    availability: z
      .enum([
        /** An adapter exists and is registered. */
        'adapter',
        /** Real integration, blocked on a commercial contract or a government licence. */
        'licence_required',
        /** Intended, no adapter and no blocker yet. */
        'planned',
      ])
      .default('adapter'),
    sandboxUrl: HttpUrl.optional(),
    documentation: HttpUrl.optional(),
  })
  .refine((r) => r.availability !== 'adapter' || !!r.adapterId, {
    message:
      "adapterId is required when availability is 'adapter' — a regulator " +
      'claiming an adapter must name one that exists',
    path: ['adapterId'],
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

// ── Declarative rules (json-logic) ────────────────────────────────────────

/**
 * A named predicate over an entity, expressed as JsonLogic.
 *
 * JsonLogic and not an expression string, for one reason that outweighs
 * ergonomics: a config pack is authored by a non-engineer and loaded from disk
 * at boot, so an expression language with host access would be a sandbox escape
 * with a JSON file for a payload. JsonLogic has no host access by construction —
 * it is data, and the worst a malicious rule can do is evaluate to the wrong
 * boolean.
 *
 * Consumed by FORM validation, WF transition conditions, and `alertRules.when`.
 * One evaluator, three call sites — the alternative was three condition
 * languages that disagree about what `null` means.
 */
const RuleSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  /**
   * JsonLogic. `{"<":[{"var":"age"},18]}`. Kept as `unknown` because the shape
   * is recursive and open-ended; the evaluator validates it at load time and
   * refuses to register a rule it cannot compile, rather than failing later on
   * the one record that trips the bad branch.
   */
  when: z.unknown(),
  /** Message shown when the rule matches. Supports `{{field}}` placeholders. */
  message: z.string().optional(),
  severity: z.enum(['info', 'warning', 'error']).default('error'),
});

// ── Alert rules ───────────────────────────────────────────────────────────

/**
 * "Tell someone when X becomes true." The single mechanism behind visa expiry
 * warnings, turnover thresholds, obligation deadlines, overdue payments, SLA
 * breaches and document expiry — nine separately-named features in the two
 * specs that are one loop over entities with a predicate and a notification.
 */
const AlertRuleSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /** Entity type to scan, e.g. `case`, `obligation`, `turnover_record`. */
  entityType: z.string().min(1),
  /**
   * JsonLogic over the entity, evaluated with these extra variables available:
   * `_now` (ISO date), and for any date field `<field>_daysUntil` /
   * `<field>_daysSince`. Date arithmetic in JsonLogic is otherwise unreadable,
   * and "30 days before expiry" is the single most common rule either product
   * needs.
   */
  when: z.unknown(),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  /** Message template key from `messaging.templates`. */
  templateKey: z.string().optional(),
  /** Roles to notify. Empty means the entity's assignee only. */
  notifyRoles: z.array(z.string()).default([]),
  /** Also open a task, so the alert has an owner rather than just an inbox. */
  createTask: z.boolean().default(false),
  /**
   * Escalate to these roles if still matching after this many hours. Null means
   * no escalation — an alert that escalates forever is worse than one that does
   * not escalate at all.
   */
  escalateAfterHours: z.number().positive().nullable().default(null),
  escalateToRoles: z.array(z.string()).default([]),
  /**
   * Minimum hours between repeat notifications for the same entity+rule.
   * Without this a daily sweep emails the same person about the same case every
   * day until they fix it, which trains people to filter the alerts.
   */
  cooldownHours: z.number().positive().default(24),
});

// ── Fees and payment plans ────────────────────────────────────────────────

/**
 * What something costs. Government fees, firm fees and disbursements are
 * different money with different rules, and `payments` had one undifferentiated
 * `amountMinor` — so a government charge passed through at cost was
 * indistinguishable from the firm's own revenue.
 */
const FeeSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /**
   * `government` is collected on the regulator's behalf and is usually
   * non-refundable and not revenue; `firm` is the firm's own charge;
   * `disbursement` is a third-party cost passed through.
   */
  kind: z.enum(['government', 'firm', 'disbursement']).default('firm'),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** Per applicant, per case, or per included dependent. */
  basis: z.enum(['per_case', 'per_applicant', 'per_dependent']).default('per_case'),
  refundable: z.boolean().default(false),
  /** Regulatory citation for a government fee, so the amount is defensible. */
  reference: z.string().optional(),
  /** Which workflow step collects it, if it is stage-gated. */
  atStep: z.string().optional(),
});

const PaymentPlanSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /**
   * `installments` is EMI; `stage_gated` ties each portion to a workflow step;
   * `upfront` is one payment.
   */
  type: z.enum(['upfront', 'installments', 'stage_gated']).default('upfront'),
  /** For `installments`. */
  installmentCount: z.number().int().positive().optional(),
  intervalDays: z.number().int().positive().optional(),
  /**
   * For `stage_gated`: portions in basis points of the total (10000 = 100%), so
   * a split is exact. Percentages as floats do not sum to the total and the
   * remainder lands on whichever line rounds last.
   */
  stages: z
    .array(
      z.object({
        atStep: z.string(),
        portionBps: z.number().int().positive().max(10000),
        label: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * Block workflow progress past `atStep` until that portion is settled. This
   * is the "case freeze on non-payment" requirement; the pack declares it and
   * WF enforces it.
   */
  blockProgressOnArrears: z.boolean().default(false),
});

// ── Scoring models ────────────────────────────────────────────────────────

/**
 * Weighted-factor scoring: lead scoring, visa recommendation, generic risk
 * scoring. All three were separately-named features that are one weighted sum
 * plus banding.
 */
const ScoringModelSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  entityType: z.string().min(1),
  factors: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        /** JsonLogic predicate; the weight is added when it matches. */
        when: z.unknown(),
        weight: z.number(),
      }),
    )
    .min(1),
  /**
   * Bands, evaluated in order; the first whose `minScore` is met wins. Ordered
   * rather than range-based so an author cannot leave a gap between bands that
   * silently produces an unbanded score.
   */
  bands: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        minScore: z.number(),
        color: z.string().optional(),
      }),
    )
    .default([]),
});

// ── Typed relationships ───────────────────────────────────────────────────

/**
 * A declared edge between two entity types: document relationships, task and
 * milestone dependencies, counterparty links. One generic edge table serves all
 * of them.
 */
const RelationshipSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  fromType: z.string().min(1),
  toType: z.string().min(1),
  cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_many']).default('many_to_many'),
  /** Label for traversing the other way, e.g. "blocks" ↔ "blocked by". */
  inverseLabel: z.string().optional(),
  /**
   * Refuse to close/complete the `from` entity while a `to` entity is open.
   * This is what makes a dependency a dependency rather than a note.
   */
  blocksCompletion: z.boolean().default(false),
});

// ── Navigation and dashboards ─────────────────────────────────────────────

/**
 * The vertical's sidebar. In the pack because a hardcoded nav is why adding an
 * entity type still needed a frontend change — which defeats the point of
 * `entityTypes` being config.
 */
const NavItemSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /** App-relative path. */
  path: z.string(),
  icon: z.string().optional(),
  /** Entitlement module gating this item, e.g. `payments`. */
  module: z.string().optional(),
  /** Roles that may see it. Empty means all. */
  roles: z.array(z.string()).default([]),
  /** Which portal it belongs to. */
  portal: z.enum(['admin', 'staff', 'client', 'platform']).default('staff'),
  order: z.number().int().default(0),
});

const DashboardSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  portal: z.enum(['admin', 'staff', 'client', 'platform']).default('staff'),
  roles: z.array(z.string()).default([]),
  widgets: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        /** `kpi` reads a `kpis[]` entry; the others read entities. */
        type: z.enum(['kpi', 'count', 'list', 'chart', 'checklist']),
        /** For `kpi`: the kpis[] key. Otherwise the entity type to query. */
        source: z.string(),
        /** JsonLogic filter over the source entities. */
        when: z.unknown().optional(),
        /** Grid width in twelfths. */
        span: z.number().int().min(1).max(12).default(4),
      }),
    )
    .default([]),
});

// ── Import mappings ───────────────────────────────────────────────────────

/**
 * Field maps for bringing records in from a spreadsheet or another CRM. In the
 * pack because the target fields are the vertical's own `entityTypes` fields,
 * which core does not know the names of.
 */
const ImportMappingSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  source: z.enum(['csv', 'xlsx', 'hubspot', 'zoho', 'salesforce']),
  targetEntityType: z.string().min(1),
  fields: z
    .array(
      z.object({
        /** Column header or remote field name. */
        from: z.string(),
        /** Entity field key, or `verticalAttributes.<key>`. */
        to: z.string(),
        required: z.boolean().default(false),
        /** Named transform applied on the way in. */
        transform: z
          .enum(['trim', 'lowercase', 'uppercase', 'date_iso', 'phone_e164', 'country_iso2'])
          .optional(),
      }),
    )
    .min(1),
  /**
   * Fields that together identify an existing record, so a re-run updates
   * rather than duplicating. An importer with no dedupe key turns a retry after
   * a partial failure into two copies of every row.
   */
  dedupeOn: z.array(z.string()).default([]),
});

// ── Messaging sequences ───────────────────────────────────────────────────

/**
 * Multi-step outbound messaging: payment reminders, RFI follow-ups, document
 * chasers, onboarding nurture, newsletters. Eight separately-named features in
 * the two specs, one state machine.
 */
const SequenceSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /** What starts it. */
  trigger: z.object({
    entityType: z.string(),
    /** JsonLogic over the entity; when it becomes true, enrolment happens. */
    when: z.unknown(),
  }),
  steps: z
    .array(
      z.object({
        templateKey: z.string(),
        /** Delay from enrolment, not from the previous step, so a slipped step cannot cascade. */
        afterHours: z.number().nonnegative().default(0),
        /** Optional extra condition checked at send time. */
        when: z.unknown().optional(),
      }),
    )
    .min(1),
  /**
   * Stop conditions. Without at least one of these a sequence keeps emailing
   * someone who has already done the thing it is asking for, which is the
   * single most common way automated messaging damages a client relationship.
   */
  stopWhen: z.unknown().optional(),
  stopOnReply: z.boolean().default(true),
  /** Never send more than this many messages, whatever the steps say. */
  maxMessages: z.number().int().positive().default(5),
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

  /** Outbound messaging: templates, and the sequences that chain them. */
  messaging: z
    .object({
      templates: z.array(MessageTemplateSchema).default([]),
      sequences: z.array(SequenceSchema).default([]),
    })
    .optional(),

  /**
   * The remaining Layer 4 vocabulary. Each of these exists because the feature
   * it expresses recurs in BOTH verticals, so building it as code in `src/`
   * would violate the 80/20 rule (CLAUDE.md §11.3) — and because without them
   * 32 requirements across the GovX and immigration specs had no home except
   * vertical-specific code. See docs/FEATURE_PARITY_MAP.md §5.
   *
   * All optional and additive: an existing pack keeps loading unchanged.
   */
  rules: z.array(RuleSchema).optional(),
  alertRules: z.array(AlertRuleSchema).optional(),
  fees: z.array(FeeSchema).optional(),
  paymentPlans: z.array(PaymentPlanSchema).optional(),
  scoringModels: z.array(ScoringModelSchema).optional(),
  relationships: z.array(RelationshipSchema).optional(),
  navigation: z.array(NavItemSchema).optional(),
  dashboards: z.array(DashboardSchema).optional(),
  importMappings: z.array(ImportMappingSchema).optional(),

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
