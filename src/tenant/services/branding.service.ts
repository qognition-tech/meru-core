import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';
import { BrandingDto } from '../dto/branding.dto';

export interface TenantBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  displayName: string;
  timezone: string;
  onboardingComplete: boolean;
}

/**
 * Tenant branding, stored on `tenants.settings.branding`. The vertical apps
 * read this once at layout time and inject it as CSS variables, so a firm
 * sees its own logo and palette. Reading is open to any authenticated member
 * (the shell renders it); writing is admin-only.
 */
@Injectable()
export class BrandingService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  async get(tenantId: string): Promise<TenantBranding> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');

    const b = (tenant.settings?.branding ?? {}) as Record<string, unknown>;
    return {
      logoUrl: (b.logo as string) ?? null,
      faviconUrl: (b.faviconUrl as string) ?? null,
      primaryColor: (b.colors as { primary?: string } | undefined)?.primary ?? null,
      accentColor: (b.colors as { secondary?: string } | undefined)?.secondary ?? null,
      displayName: (b.displayName as string) ?? tenant.name,
      timezone: (b.timezone as string) ?? 'UTC',
      onboardingComplete: (b.onboardingComplete as boolean) ?? false,
    };
  }

  async update(tenantId: string, dto: BrandingDto): Promise<TenantBranding> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');

    const settings = tenant.settings ?? {};
    const branding = (settings.branding ?? {}) as Record<string, unknown>;
    const colors = (branding.colors ?? {}) as {
      primary?: string;
      secondary?: string;
    };

    if (dto.logoUrl !== undefined) branding.logo = dto.logoUrl;
    if (dto.faviconUrl !== undefined) branding.faviconUrl = dto.faviconUrl;
    if (dto.primaryColor !== undefined) colors.primary = dto.primaryColor;
    if (dto.accentColor !== undefined) colors.secondary = dto.accentColor;
    if (dto.displayName !== undefined) branding.displayName = dto.displayName;
    if (dto.timezone !== undefined) branding.timezone = dto.timezone;
    if (dto.onboardingComplete !== undefined) {
      branding.onboardingComplete = dto.onboardingComplete;
    }
    branding.colors = colors;

    tenant.settings = { ...settings, branding: branding as never };
    await this.tenantRepo.save(tenant);
    return this.get(tenantId);
  }
}
