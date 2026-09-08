import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { CronSecretGuard } from '../jobs/cron-secret.guard';
import { Public } from '../iam/decorators/public.decorator';
import {
  AisIngestService,
  type AisIngestResult,
} from './services/ais-ingest.service';
import { AisIngestDto } from './dto/ais-ingest.dto';

/**
 * AIS feed intake.
 *
 * A **separate controller** from `IntegrationsController` on purpose. That one
 * carries a class-level `AuthGuard('jwt')`, and Nest composes class and method
 * guards rather than letting the method override — so a `CronSecretGuard` added
 * to a route there still has to get past the JWT guard first, and a machine
 * presenting `Bearer <CRON_SECRET>` is rejected before it is ever considered.
 *
 * The separation is also the honest modelling: this is infrastructure, not a
 * user action. Positions are platform-global facts, so there is no tenant to
 * scope the request to and no user whose permissions would mean anything.
 */
@ApiTags('integrations')
@Controller('integrations/vessel/ais')
@Public() // authenticated by CronSecretGuard below, not by user JWT
@UseGuards(CronSecretGuard)
@ApiSecurity('cron-secret')
export class AisIngestController {
  constructor(private readonly aisIngest: AisIngestService) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ingest an AIS feed batch',
    description:
      'Accepts raw AIVDM/AIVDO sentences and/or pre-decoded positions from ' +
      'any AIS source — a dockside receiver, an aggregator, AISStream. This ' +
      'is what lets vessel tracking work without a commercial AIS API. ' +
      'Authenticate with `Authorization: Bearer <CRON_SECRET>`.',
  })
  @ApiResponse({ status: 200, description: 'Batch processed' })
  @ApiResponse({ status: 401, description: 'Missing or wrong CRON_SECRET' })
  async ingest(@Body() dto: AisIngestDto) {
    const batches: AisIngestResult[] = [];

    if (dto.sentences?.length) {
      batches.push(await this.aisIngest.ingestNmea(dto.sentences));
    }
    if (dto.positions?.length) {
      batches.push(await this.aisIngest.ingestPositions(dto.positions));
    }

    // Summed so a caller sending both kinds in one batch gets one answer.
    return batches.reduce(
      (acc, r) => ({
        received: acc.received + r.received,
        decoded: acc.decoded + r.decoded,
        vesselsUpdated: acc.vesselsUpdated + r.vesselsUpdated,
        ignored: acc.ignored + r.ignored,
        errors: [...acc.errors, ...r.errors],
      }),
      {
        received: 0,
        decoded: 0,
        vesselsUpdated: 0,
        ignored: 0,
        errors: [] as string[],
      },
    );
  }
}
