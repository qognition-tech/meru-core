import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationAdapter } from './entities/integration-adapter.entity';
import { AuHomeAffairsAdapter } from './adapters/au-home-affairs.adapter';
import { UaeCentralBankAdapter } from './adapters/uae-central-bank.adapter';
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
  imports: [TypeOrmModule.forFeature([IntegrationAdapter])],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    AuHomeAffairsAdapter,
    UaeCentralBankAdapter,
  ],
  exports: [IntegrationsService, AuHomeAffairsAdapter, UaeCentralBankAdapter],
})
export class IntegrationsModule {}
