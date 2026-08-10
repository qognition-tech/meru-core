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
];
