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

// INT module per CLAUDE.md §2 row 14.
// Government API adapters — each adapter implements GovernmentAdapter interface.
// Vertical packs reference adapters by ID (e.g. "au-home-affairs", "uae-central-bank")
// in their JSON workflow steps, never by class name.
//
// Adding a new adapter: create adapters/<country>-<regulator>.adapter.ts,
// register as a provider here, export from IntegrationsService.
@Module({
  imports: [TypeOrmModule.forFeature([IntegrationAdapter]), IamModule],
  controllers: [IntegrationsController],
  providers: [
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
