import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag } from '../entities/feature-flag.entity';
import { UpsertFeatureFlagDto } from '../dto/upsert-feature-flag.dto';

/**
 * Tenant-scoped feature flags (TCM). RLS scopes every query to the bound
 * tenant; `tenantId` is still set explicitly on insert because the RLS insert
 * policy requires the row to match the bound tenant, not because the read
 * path needs it.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flagRepo: Repository<FeatureFlag>,
  ) {}

  list(tenantId: string): Promise<FeatureFlag[]> {
    return this.flagRepo.find({
      where: { tenantId },
      order: { flagKey: 'ASC' },
    });
  }

  async upsert(
    tenantId: string,
    flagKey: string,
    dto: UpsertFeatureFlagDto,
  ): Promise<FeatureFlag> {
    const existing = await this.flagRepo.findOne({
      where: { tenantId, flagKey },
    });

    const flag =
      existing ?? this.flagRepo.create({ tenantId, flagKey, flagValue: true });

    if (dto.value !== undefined) flag.flagValue = dto.value;
    if (dto.description !== undefined) flag.description = dto.description;
    if (dto.isActive !== undefined) flag.isActive = dto.isActive;
    if (dto.rolloutPercentage !== undefined)
      flag.rolloutPercentage = dto.rolloutPercentage;
    if (dto.targetRoles !== undefined) flag.targetRoles = dto.targetRoles;

    return this.flagRepo.save(flag);
  }

  async remove(tenantId: string, flagKey: string): Promise<void> {
    const result = await this.flagRepo.delete({ tenantId, flagKey });
    if (!result.affected) {
      throw new NotFoundException(`Feature flag '${flagKey}' not found`);
    }
  }
}
