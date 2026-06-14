import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigPack } from '../entities/config-pack.entity';
import { TenantConfigPin } from '../../iam/entities/tenant-config-pin.entity';
import { AuditService } from '../../audit/audit.service';

export interface CreateConfigPackDto {
  code: string;
  name: string;
  description?: string;
  version: string;
  vertical?: string;
  schema?: Record<string, any>;
  defaults?: Record<string, any>;
  uiConfig?: Record<string, any>;
}

export interface PinConfigPackDto {
  configPackId: string;
  pinnedVersion: string;
  pinnedBy: string;
  overrides?: Record<string, any>;
}

@Injectable()
export class ConfigPackService {
  private readonly logger = new Logger(ConfigPackService.name);

  constructor(
    @InjectRepository(ConfigPack)
    private configPackRepo: Repository<ConfigPack>,
    @InjectRepository(TenantConfigPin)
    private pinRepo: Repository<TenantConfigPin>,
    private auditService: AuditService,
  ) {}

  // ========== CRUD ==========

  async create(dto: CreateConfigPackDto): Promise<ConfigPack> {
    const existing = await this.configPackRepo.findOne({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(
        `Config pack with code '${dto.code}' already exists`,
      );
    }

    const pack = this.configPackRepo.create({
      code: dto.code,
      name: dto.name,
      description: dto.description,
      version: dto.version,
      vertical: dto.vertical,
      schema: dto.schema || {},
      defaults: dto.defaults || {},
      uiConfig: dto.uiConfig || {},
      isActive: true,
    });

    const saved = await this.configPackRepo.save(pack);
    this.logger.log(`Config pack created: ${saved.code} v${saved.version}`);
    return saved;
  }

  async findAll(vertical?: string): Promise<ConfigPack[]> {
    const where: any = {};
    if (vertical) {
      where.vertical = vertical;
    }
    return this.configPackRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  async findById(id: string): Promise<ConfigPack> {
    const pack = await this.configPackRepo.findOne({ where: { id } });
    if (!pack) {
      throw new NotFoundException(`Config pack '${id}' not found`);
    }
    return pack;
  }

  async findByCode(code: string): Promise<ConfigPack> {
    const pack = await this.configPackRepo.findOne({ where: { code } });
    if (!pack) {
      throw new NotFoundException(`Config pack '${code}' not found`);
    }
    return pack;
  }

  // ========== VERSION MANAGEMENT ==========

  async promoteVersion(
    id: string,
    newVersion: string,
    userId: string,
  ): Promise<ConfigPack> {
    const pack = await this.findById(id);

    if (newVersion === pack.version) {
      throw new BadRequestException(
        `Config pack is already at version ${newVersion}`,
      );
    }

    const previousVersion = pack.version;
    pack.version = newVersion;

    const updated = await this.configPackRepo.save(pack);

    await this.auditService.logEvent({
      tenantId: 'system',
      userId,
      action: 'config_pack.version_promoted' as any,
      entityType: 'config_pack',
      entityId: id,
      description: `Version promoted from ${previousVersion} to ${newVersion}`,
      context: { previousVersion, newVersion },
    });

    this.logger.log(
      `Config pack '${pack.code}' promoted: v${previousVersion} → v${newVersion}`,
    );

    return updated;
  }

  async update(id: string, updates: Partial<ConfigPack>): Promise<ConfigPack> {
    const pack = await this.findById(id);
    Object.assign(pack, updates);
    return this.configPackRepo.save(pack);
  }

  async deactivate(id: string): Promise<ConfigPack> {
    const pack = await this.findById(id);
    pack.isActive = false;
    return this.configPackRepo.save(pack);
  }

  async delete(id: string): Promise<void> {
    const pack = await this.findById(id);

    // Check if any tenants have this pinned
    const pins = await this.pinRepo.count({
      where: { configPackId: id },
    });

    if (pins > 0) {
      throw new ConflictException(
        `Cannot delete config pack with ${pins} active tenant pins. Unpin all tenants first.`,
      );
    }

    await this.configPackRepo.remove(pack);
    this.logger.log(`Config pack deleted: ${pack.code}`);
  }

  // ========== TENANT PINNING ==========

  async pinToTenant(
    tenantId: string,
    dto: PinConfigPackDto,
  ): Promise<TenantConfigPin> {
    await this.findById(dto.configPackId);

    // Check if already pinned
    const existing = await this.pinRepo.findOne({
      where: { tenantId, configPackId: dto.configPackId },
    });

    if (existing) {
      existing.pinnedVersion = dto.pinnedVersion;
      existing.overrides = dto.overrides || existing.overrides;
      existing.pinnedBy = dto.pinnedBy;
      existing.pinnedAt = new Date();
      return this.pinRepo.save(existing);
    }

    const pin = this.pinRepo.create({
      tenantId,
      configPackId: dto.configPackId,
      pinnedVersion: dto.pinnedVersion,
      pinnedBy: dto.pinnedBy,
      overrides: dto.overrides || {},
    });

    const saved = await this.pinRepo.save(pin);
    this.logger.log(
      `Config pack pinned to tenant ${tenantId}: v${dto.pinnedVersion}`,
    );
    return saved;
  }

  async unpinFromTenant(tenantId: string, configPackId: string): Promise<void> {
    const pin = await this.pinRepo.findOne({
      where: { tenantId, configPackId },
    });

    if (!pin) {
      throw new NotFoundException('Config pack is not pinned to this tenant');
    }

    await this.pinRepo.remove(pin);
    this.logger.log(`Config pack unpinned from tenant ${tenantId}`);
  }

  async getTenantPins(tenantId: string): Promise<TenantConfigPin[]> {
    return this.pinRepo.find({
      where: { tenantId },
      relations: ['configPack'],
      order: { pinnedAt: 'DESC' },
    });
  }

  async getTenantEffectiveConfig(
    tenantId: string,
    configPackCode: string,
  ): Promise<ConfigPack & { overrides: Record<string, any> }> {
    const pack = await this.findByCode(configPackCode);

    const pin = await this.pinRepo.findOne({
      where: { tenantId, configPackId: pack.id },
    });

    if (!pin) {
      throw new NotFoundException(
        `Config pack '${configPackCode}' is not pinned to this tenant`,
      );
    }

    // Resolve the pinned version
    const pinnedPack = await this.configPackRepo.findOne({
      where: { id: pin.configPackId },
    });

    if (!pinnedPack) {
      return { ...pack, overrides: pin.overrides || {} };
    }

    return {
      ...pinnedPack,
      ...pin.overrides, // Tenant overrides take precedence
      overrides: pin.overrides || {},
    };
  }

  // ========== PROMOTE ACROSS ENVIRONMENTS ==========

  async promoteToAllTenants(
    configPackId: string,
    newVersion: string,
    promotedBy: string,
  ): Promise<{ updated: number; version: string }> {
    const pack = await this.findById(configPackId);

    // Update all pinned tenants to new version
    const pins = await this.pinRepo.find({
      where: { configPackId },
    });

    let updated = 0;
    for (const pin of pins) {
      pin.pinnedVersion = newVersion;
      pin.pinnedBy = promotedBy;
      pin.pinnedAt = new Date();
      await this.pinRepo.save(pin);
      updated++;
    }

    // Also promote the pack itself
    pack.version = newVersion;
    await this.configPackRepo.save(pack);

    this.logger.log(
      `Config pack '${pack.code}' promoted to v${newVersion} for ${updated} tenants`,
    );

    return { updated, version: newVersion };
  }
}
