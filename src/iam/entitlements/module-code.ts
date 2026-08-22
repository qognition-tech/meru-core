/**
 * The entitlement vocabulary.
 *
 * ADDITIVE ONLY. ImmiStack tenants are live on the first thirteen codes, and
 * every tenant's grant is frozen into `tenants.settings.modules` at
 * provisioning (CLAUDE.md §7.2). Renaming or removing a code here rewrites
 * nothing in the database — it silently stops a live grant from resolving,
 * and the first symptom is a customer losing a module in production. New
 * verticals append; they never replace.
 */
export enum ModuleCode {
  // ── Core — granted to every tenant, never gated ──────────────────────────
  CRM = 'crm',
  CASES = 'cases',
  TASKS = 'tasks',
  DOCUMENTS = 'documents',
  PAYMENTS = 'payments',
  COMMUNICATIONS = 'communications',

  // ── Plan tiers — the original (immigration-era) capability modules ──────
  FORMS = 'forms',
  AI_AUTOMATION = 'ai_automation',
  ADVANCED_ANALYTICS = 'advanced_analytics',
  MARKETING = 'marketing',
  BRANDING = 'branding',
  API_ACCESS = 'api_access',
  SSO = 'sso',

  // ── Banking GRC — added 2026-08-22, granted to GRC tenants only ─────────
  SCREENING = 'screening',
  TRADE_FINANCE = 'trade_finance',
  VESSEL_TRACKING = 'vessel_tracking',
}

export const CORE_MODULE_CODES: readonly ModuleCode[] = [
  ModuleCode.CRM,
  ModuleCode.CASES,
  ModuleCode.TASKS,
  ModuleCode.DOCUMENTS,
  ModuleCode.PAYMENTS,
  ModuleCode.COMMUNICATIONS,
];

/**
 * The codes that only exist in the GRC vocabulary. A grant that contains any
 * of these was issued after the vocabulary was extended, and may therefore
 * be enforced; a grant that contains none predates it and is treated as
 * ungated for these modules — see `ModuleEntitlementGuard`.
 */
export const GRC_MODULE_CODES: readonly ModuleCode[] = [
  ModuleCode.SCREENING,
  ModuleCode.TRADE_FINANCE,
  ModuleCode.VESSEL_TRACKING,
];
