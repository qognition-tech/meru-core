import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConnectorMode,
  TenantConnector,
} from '../entities/tenant-connector.entity';
import { IntegrationsService } from '../integrations.service';
import { encryptCredentials } from '../../core/crypto/credential-cipher';

/**
 * Which regulator adapters each vertical may connect. This is deliberately the
 * ONLY place immigration/banking vocabulary touches the connector layer — the
 * adapters themselves are vertical-neutral, and a new vertical extends this
 * map (eventually: the config pack) rather than the adapter code.
 */
const VERTICAL_ADAPTERS: Record<string, string[]> = {
  grc: ['uae-central-bank', 'sa-sama', 'qa-central-bank', 'bh-central-bank'],
  immigration: ['au-home-affairs', 'ca-ircc', 'uk-home-office', 'nz-immigration'],
};

export interface UpsertConnectorInput {
  enabled?: boolean;
  mode?: ConnectorMode;
  /** Plaintext credentials from the tenant admin — encrypted before storage. */
  credentials?: Record<string, unknown> | null;
}

@Injectable()
export class ConnectorsService {
  constructor(
    @InjectRepository(TenantConnector)
    private readonly connectorRepo: Repository<TenantConnector>,
    private readonly integrationsService: IntegrationsService,
  ) {}

  /** Adapter catalogue for a vertical, merged with the tenant's enablement state. */
  async listForTenant(tenantId: string, vertical: string | null) {
    const allowed = (vertical && VERTICAL_ADAPTERS[vertical]) ?? [];
    const adapters = this.integrationsService
      .listAdapters()
      .filter((a) => allowed.includes(a.id));

    const rows = await this.connectorRepo.find({ where: { tenantId } });
    const byCode = new Map(rows.map((r) => [r.adapterCode, r]));

    return adapters.map((a) => {
      const row = byCode.get(a.id);
      return {
        ...a,
        enabled: row?.enabled ?? false,
        mode: row?.mode ?? ConnectorMode.SANDBOX,
        hasCredentials: !!row?.credentials,
        // `sandbox` from the adapter reports the PLATFORM's runtime state;
        // `mode` is the tenant's chosen target. Both matter in the UI.
      };
    });
  }

  async upsert(
    tenantId: string,
    vertical: string | null,
    adapterCode: string,
    input: UpsertConnectorInput,
  ): Promise<Omit<TenantConnector, 'credentials'> & { hasCredentials: boolean }> {
    const allowed = (vertical && VERTICAL_ADAPTERS[vertical]) ?? [];
    if (!allowed.includes(adapterCode)) {
      throw new BadRequestException(
        `Adapter '${adapterCode}' is not available for the '${vertical}' vertical`,
      );
    }

    const row =
      (await this.connectorRepo.findOne({
        where: { tenantId, adapterCode },
      })) ?? this.connectorRepo.create({ tenantId, adapterCode });

    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.mode !== undefined) row.mode = input.mode;
    if (input.credentials === null) row.credentials = null;
    else if (input.credentials !== undefined) {
      row.credentials = encryptCredentials(input.credentials);
    }

    if (
      row.mode === ConnectorMode.LIVE &&
      row.enabled &&
      !row.credentials
    ) {
      throw new BadRequestException(
        'Live mode requires credentials — supply them or stay in sandbox',
      );
    }

    const saved = await this.connectorRepo.save(row);
    const { credentials, ...rest } = saved;
    return { ...rest, hasCredentials: !!credentials };
  }
}
