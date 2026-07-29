import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationAdapter } from './entities/integration-adapter.entity';
import { IamModule } from '../iam/iam.module';
import { AuHomeAffairsAdapter } from './adapters/au-home-affairs.adapter';
import { UaeCentralBankAdapter } from './adapters/uae-central-bank.adapter';
import { SaSamaAdapter } from './adapters/sa-sama.adapter';
import { QaCentralBankAdapter } from './adapters/qa-central-bank.adapter';
import { BhCentralBankAdapter } from './adapters/bh-central-bank.adapter';
import { CaIrccAdapter } from './adapters/ca-ircc.adapter';
import { UkHomeOfficeAdapter } from './adapters/uk-home-office.adapter';
import { NzImmigrationAdapter } from './adapters/nz-immigration.adapter';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { VesselService } from './services/vessel.service';
import { TradeService } from './services/trade.service';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { AiModule } from '../ai/ai.module';

// INT module per CLAUDE.md §2 row 14.
// Government API adapters — each adapter implements GovernmentAdapter interface.
// Vertical packs reference adapters by ID (e.g. "au-home-affairs", "uae-central-bank")
// in their JSON workflow steps, never by class name.
//
// Adding a new adapter: create adapters/<country>-<regulator>.adapter.ts,
// register as a provider here, export from IntegrationsService.
@Module({
  imports: [
    // UniversalEntity directly rather than via CrmModule: vessel watchlists and
    // trade instruments are entity rows, but they do not want CRM's
    // create-time vertical-field validation, so they use the repository, not
    // CrmService.
    TypeOrmModule.forFeature([IntegrationAdapter, UniversalEntity]),
    IamModule,
    // VesselTrackingEngine and ScreeningEngine (CLAUDE.md §3.2, §3.4).
    AiModule,
  ],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    VesselService,
    TradeService,
    AuHomeAffairsAdapter,
    UaeCentralBankAdapter,
    SaSamaAdapter,
    QaCentralBankAdapter,
    BhCentralBankAdapter,
    CaIrccAdapter,
    UkHomeOfficeAdapter,
    NzImmigrationAdapter,
  ],
  exports: [
    IntegrationsService,
    AuHomeAffairsAdapter,
    UaeCentralBankAdapter,
    SaSamaAdapter,
    QaCentralBankAdapter,
    BhCentralBankAdapter,
    CaIrccAdapter,
    UkHomeOfficeAdapter,
    NzImmigrationAdapter,
  ],
})
export class IntegrationsModule {}
