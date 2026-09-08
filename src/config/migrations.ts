import { InitialSchema1738470000000 } from '../migrations/1738470000000-InitialSchema';
import { AddSearchAndAiTables1738479999998 } from '../migrations/1738479999998-AddSearchAndAiTables';
import { FixVerticalsAndColumns1738479999999 } from '../migrations/1738479999999-FixVerticalsAndColumns';
import { AddDocumentHubTables1743859200000 } from '../migrations/1743859200000-AddDocumentHubTables';
import { AddRowLevelSecurity1743860000000 } from '../migrations/1743860000000-AddRowLevelSecurity';
import { AddVerticalAndEnvironmentRLS1743870000000 } from '../migrations/1743870000000-AddVerticalAndEnvironmentRLS';
import { AddWorkflowFormsTasksModules1743900000000 } from '../migrations/1743900000000-AddWorkflowFormsTasksModules';
import { AddBillingAnalyticsAuditModules1743910000000 } from '../migrations/1743910000000-AddBillingAnalyticsAuditModules';
import { AddStorageQueueElasticsearch1743930000000 } from '../migrations/1743930000000-AddStorageQueueElasticsearch';
import { AlignAllTablesToSchema1744000000000 } from '../migrations/1744000000000-AlignAllTablesToSchema';
import { AddRlsAndTriggers1744010000000 } from '../migrations/1744010000000-AddRlsAndTriggers';
import { AddTenantRowLevelSecurity1753500000000 } from '../migrations/1753500000000-AddTenantRowLevelSecurity';
import { FixAuditLogNullableState1753600000000 } from '../migrations/1753600000000-FixAuditLogNullableState';
import { AddEntityLifecycleColumns1753700000000 } from '../migrations/1753700000000-AddEntityLifecycleColumns';
import { AddSessionClient1753800000000 } from '../migrations/1753800000000-AddSessionClient';
import { AddAgentRuns1753900000000 } from '../migrations/1753900000000-AddAgentRuns';
import { AddTradeInstrumentType1754000000000 } from '../migrations/1754000000000-AddTradeInstrumentType';
import { AddAuthTokens1754100000000 } from '../migrations/1754100000000-AddAuthTokens';
import { AddVesselPositions1754200000000 } from '../migrations/1754200000000-AddVesselPositions';
import { AddLeadEntityType1754600000000 } from '../migrations/1754600000000-AddLeadEntityType';
import { AddTenantConnectors1754700000000 } from '../migrations/1754700000000-AddTenantConnectors';
import { AddGovxEntityTypes1754800000000 } from '../migrations/1754800000000-AddGovxEntityTypes';
import { AddWatchlistEntries1754900000000 } from '../migrations/1754900000000-AddWatchlistEntries';
import { AddPayments1755000000000 } from '../migrations/1755000000000-AddPayments';
import { AddJobRuns1755100000000 } from '../migrations/1755100000000-AddJobRuns';
import { AddAuditWormEnforcement1755200000000 } from '../migrations/1755200000000-AddAuditWormEnforcement';
import { AddScreeningResults1755300000000 } from '../migrations/1755300000000-AddScreeningResults';
import { AddAlertFirings1755400000000 } from '../migrations/1755400000000-AddAlertFirings';
import { AddSequenceEnrolments1755500000000 } from '../migrations/1755500000000-AddSequenceEnrolments';
import { AddPaymentFeeProvenance1755600000000 } from '../migrations/1755600000000-AddPaymentFeeProvenance';
import { AddEntityRelations1755700000000 } from '../migrations/1755700000000-AddEntityRelations';
import { AddNotificationThreads1755800000000 } from '../migrations/1755800000000-AddNotificationThreads';
import { AddPaymentDirection1755900000000 } from '../migrations/1755900000000-AddPaymentDirection';
import { AddWhatsappChannel1756000000000 } from '../migrations/1756000000000-AddWhatsappChannel';
import { AddDocumentVersionStorageProvider1756100000000 } from '../migrations/1756100000000-AddDocumentVersionStorageProvider';
import { AddSarEntityType1756200000000 } from '../migrations/1756200000000-AddSarEntityType';
import { AddInboundWebhooks1756300000000 } from '../migrations/1756300000000-AddInboundWebhooks';
import { AddSearchableTaskTypes1756400000000 } from '../migrations/1756400000000-AddSearchableTaskTypes';
import { RelaxDocumentCurrentVersionIdNotNull1756410000000 } from '../migrations/1756410000000-RelaxDocumentCurrentVersionIdNotNull';
import { AddSubjectEmailToEntities1756500000000 } from '../migrations/1756500000000-AddSubjectEmailToEntities';
import { BackfillVacStatus1756600000000 } from '../migrations/1756600000000-BackfillVacStatus';
import { AddTenantFeeOverrides1756700000000 } from '../migrations/1756700000000-AddTenantFeeOverrides';

/**
 * Every migration, bundled. The Vercel serverless bundle cannot glob the
 * filesystem the way the local CLI does, and the vertical databases (govx /
 * immistack) are migrated from a deployed endpoint (jobs/migrate) precisely
 * because deploy infrastructure has the fast disks. One list, in timestamp
 * order — TypeORM re-sorts by timestamp anyway.
 */
export const ALL_MIGRATIONS = [
  InitialSchema1738470000000,
  AddSearchAndAiTables1738479999998,
  FixVerticalsAndColumns1738479999999,
  AddDocumentHubTables1743859200000,
  AddRowLevelSecurity1743860000000,
  AddVerticalAndEnvironmentRLS1743870000000,
  AddWorkflowFormsTasksModules1743900000000,
  AddBillingAnalyticsAuditModules1743910000000,
  AddStorageQueueElasticsearch1743930000000,
  AlignAllTablesToSchema1744000000000,
  AddRlsAndTriggers1744010000000,
  AddTenantRowLevelSecurity1753500000000,
  FixAuditLogNullableState1753600000000,
  AddEntityLifecycleColumns1753700000000,
  AddSessionClient1753800000000,
  AddAgentRuns1753900000000,
  AddTradeInstrumentType1754000000000,
  AddAuthTokens1754100000000,
  AddVesselPositions1754200000000,
  AddLeadEntityType1754600000000,
  AddTenantConnectors1754700000000,
  AddGovxEntityTypes1754800000000,
  AddWatchlistEntries1754900000000,
  AddPayments1755000000000,
  AddJobRuns1755100000000,
  AddAuditWormEnforcement1755200000000,
  AddScreeningResults1755300000000,
  AddAlertFirings1755400000000,
  AddSequenceEnrolments1755500000000,
  AddPaymentFeeProvenance1755600000000,
  AddEntityRelations1755700000000,
  // The three below were on disk but missing from this list, so the deployed
  // `/jobs/migrate/:target` route — which uses this array, unlike the CLI's
  // glob — would have skipped them. A migration that is not in this list does
  // not exist as far as production is concerned; add every new one here.
  AddNotificationThreads1755800000000,
  AddPaymentDirection1755900000000,
  AddWhatsappChannel1756000000000,
  AddDocumentVersionStorageProvider1756100000000,
  AddSarEntityType1756200000000,
  // Found missing from this list while adding AddSearchableTaskTypes below —
  // same trap the comment above already describes. On disk since 2026-08-22
  // (AGENTS.md §3.0b, inbound webhooks) but never registered here, so
  // `/jobs/migrate/:target` against a fresh database would never have created
  // `webhook_endpoints` / `webhook_deliveries`.
  AddInboundWebhooks1756300000000,
  AddSearchableTaskTypes1756400000000,
  RelaxDocumentCurrentVersionIdNotNull1756410000000,
  AddSubjectEmailToEntities1756500000000,
  BackfillVacStatus1756600000000,
  AddTenantFeeOverrides1756700000000,
];
