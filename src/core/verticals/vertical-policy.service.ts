import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { VerticalType } from '../../iam/enums/vertical.enum';

export interface VerticalPolicy {
  vertical: VerticalType;
  rules: {
    mfaRequired: boolean;
    ipWhitelist?: string[];
    businessHours?: { start: number; end: number };
    dataRetentionDays: number;
  };
}

@Injectable()
export class VerticalPolicyService {
  private readonly logger = new Logger(VerticalPolicyService.name);

  // Interim in-memory defaults. PolicyGuard now resolves the tenant's REAL
  // vertical, so these rules are live enforcement, not dead code: an IP
  // whitelist or business-hours window here blocks actual traffic for every
  // tenant of that vertical. They therefore ship permissive (no IP list,
  // 24h access) until per-tenant policies load from config packs / tenant
  // settings (Phase 1 of docs/MASTER_GAP_ANALYSIS_AND_PLAN.md). The earlier
  // mock values (`ipWhitelist: ['10.0.0.1']`, 9–17 hours on immigration)
  // would have locked every ImmiStack tenant out.
  private verticalConfigs: Record<VerticalType, VerticalPolicy> = {
    [VerticalType.GRC]: {
      vertical: VerticalType.GRC,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 2555,
      },
    },
    [VerticalType.IMMIGRATION]: {
      vertical: VerticalType.IMMIGRATION,
      rules: {
        mfaRequired: false,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 3650,
      },
    },
    [VerticalType.LABOUR]: {
      vertical: VerticalType.LABOUR,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 1825,
      },
    },
    [VerticalType.FINTECH]: {
      vertical: VerticalType.FINTECH,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 2555,
      },
    },
    [VerticalType.LEGAL]: {
      vertical: VerticalType.LEGAL,
      rules: {
        mfaRequired: false,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 3650,
      },
    },
  };

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async getPolicy(vertical: VerticalType): Promise<VerticalPolicy> {
    const cacheKey = `vertical_policy:${vertical}`;

    // 1. Try Cache
    const cachedPolicy = await this.cacheManager.get<VerticalPolicy>(cacheKey);
    if (cachedPolicy) {
      return cachedPolicy;
    }

    // 2. Fetch Source
    const policy = this.verticalConfigs[vertical];

    // 3. Set Cache (1 Hour TTL)
    await this.cacheManager.set(cacheKey, policy, 3600);

    this.logger.log(`Policy loaded for ${vertical}`);
    return policy;
  }
}
