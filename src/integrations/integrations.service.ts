import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuHomeAffairsAdapter } from './adapters/au-home-affairs.adapter';
import { UaeCentralBankAdapter } from './adapters/uae-central-bank.adapter';
import { SaSamaAdapter } from './adapters/sa-sama.adapter';
import { QaCentralBankAdapter } from './adapters/qa-central-bank.adapter';
import { BhCentralBankAdapter } from './adapters/bh-central-bank.adapter';
import { CaIrccAdapter } from './adapters/ca-ircc.adapter';
import { UkHomeOfficeAdapter } from './adapters/uk-home-office.adapter';
import { NzImmigrationAdapter } from './adapters/nz-immigration.adapter';
import type {
  GovernmentAdapter,
  AdapterCapability,
} from './interfaces/government-adapter.interface';

// Registry pattern: callers resolve adapters by ID.
// Keeps vertical pack JSON decoupled from concrete classes.
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly registry = new Map<string, GovernmentAdapter>();

  constructor(
    auHomeAffairs: AuHomeAffairsAdapter,
    uaeCentralBank: UaeCentralBankAdapter,
    saSama: SaSamaAdapter,
    qaCentralBank: QaCentralBankAdapter,
    bhCentralBank: BhCentralBankAdapter,
    caIrcc: CaIrccAdapter,
    ukHomeOffice: UkHomeOfficeAdapter,
    nzImmigration: NzImmigrationAdapter,
  ) {
    this.register(auHomeAffairs);
    this.register(uaeCentralBank);
    this.register(saSama);
    this.register(qaCentralBank);
    this.register(bhCentralBank);
    this.register(caIrcc);
    this.register(ukHomeOffice);
    this.register(nzImmigration);
  }

  private register(adapter: GovernmentAdapter): void {
    this.registry.set(adapter.adapterId, adapter);
    this.logger.log(
      `Registered adapter: ${adapter.adapterId} (${adapter.regulatorName})`,
    );
  }

  getAdapter(adapterId: string): GovernmentAdapter {
    const adapter = this.registry.get(adapterId);
    if (!adapter)
      throw new NotFoundException(
        `No adapter registered for id '${adapterId}'`,
      );
    return adapter;
  }

  getAdapterWithCapability(
    adapterId: string,
    capability: AdapterCapability,
  ): GovernmentAdapter {
    const adapter = this.getAdapter(adapterId);
    if (!adapter.supportsCapability(capability)) {
      throw new Error(
        `Adapter '${adapterId}' does not support capability '${capability}'`,
      );
    }
    return adapter;
  }

  listAdapters(): Array<{
    id: string;
    country: string;
    regulator: string;
    sandbox: boolean;
    capabilities: AdapterCapability[];
  }> {
    const capabilities: AdapterCapability[] = [
      'visa_status',
      'application_status',
      'sponsor_validation',
      'lodge_application',
      'vevo_check',
      'right_to_work',
      'visa_view',
      'screening',
      'sar_filing',
      'document_verification',
      'identity_verification',
    ];
    return Array.from(this.registry.values()).map((a) => ({
      id: a.adapterId,
      country: a.country,
      regulator: a.regulatorName,
      sandbox: a.isSandbox(),
      capabilities: capabilities.filter((c) => a.supportsCapability(c)),
    }));
  }

  /**
   * Health for every registered adapter — honestly.
   *
   * A sandboxed adapter's `healthCheck()` performs zero I/O (see
   * `adapters/*.adapter.ts`'s sandbox short-circuit) and used to report
   * `status: 'healthy'` anyway, with the one field that said otherwise
   * (`message: 'Sandbox mode — no live API calls'`) and `isSandbox()` itself
   * both discarded on the way out — `latencyMs: 0` across all eight was the
   * only surviving tell. This coerces the reported status to `'unknown'`
   * whenever the adapter did not actually probe anything, and carries
   * `sandbox` / `hasCredentials` / `message` / `lastCheckedAt` through instead
   * of dropping them, matching what `/integrations/connectors` already
   * discloses per tenant.
   */
  async healthCheckAll(): Promise<
    Array<{
      adapterId: string;
      status: string;
      latencyMs: number;
      sandbox: boolean;
      probed: boolean;
      hasCredentials: boolean;
      message: string | null;
      lastCheckedAt: string | null;
    }>
  > {
    const adapters = Array.from(this.registry.values());
    const results = await Promise.allSettled(
      adapters.map(async (a) => {
        const result = await a.healthCheck();
        return { adapter: a, result };
      }),
    );

    return results.map((r, i) => {
      const adapter = adapters[i];
      if (r.status === 'rejected') {
        const reason =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        return {
          adapterId: adapter.adapterId,
          status: 'down',
          latencyMs: 0,
          sandbox: adapter.isSandbox(),
          probed: !adapter.isSandbox(),
          hasCredentials: adapter.hasCredentials(),
          message: reason,
          lastCheckedAt: null,
        };
      }

      const { result } = r.value;
      const sandbox = adapter.isSandbox();
      // Sandbox adapters short-circuit before any I/O, so their own
      // `'healthy'`/`'degraded'`/`'down'` is not an observed fact — it is
      // never anything but the sandbox branch's hardcoded return. Report the
      // honest state instead of repeating it.
      const status = sandbox ? 'unknown' : result.status;

      return {
        adapterId: adapter.adapterId,
        status,
        latencyMs: result.latencyMs,
        sandbox,
        probed: !sandbox,
        hasCredentials: adapter.hasCredentials(),
        message: result.message ?? null,
        lastCheckedAt: result.lastCheckedAt
          ? new Date(result.lastCheckedAt).toISOString()
          : null,
      };
    });
  }
}
