import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CapabilitiesService } from './capabilities.service';

@Module({
  controllers: [HealthController],
  providers: [CapabilitiesService],
  // Exported so a feature can ask whether its own capability is configured
  // rather than re-reading env vars and drifting from this report.
  exports: [CapabilitiesService],
})
export class HealthModule {}
