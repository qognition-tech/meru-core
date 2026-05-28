import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigPackService } from '../services/config-pack.service';
import type {
  CreateConfigPackDto,
  PinConfigPackDto,
} from '../services/config-pack.service';

@Controller('config-packs')
export class ConfigPackController {
  constructor(private readonly configPackService: ConfigPackService) {}

  // ========== CRUD ==========

  @Post()
  async create(@Body() dto: CreateConfigPackDto) {
    return this.configPackService.create(dto);
  }

  @Get()
  async findAll(@Query('vertical') vertical?: string) {
    return this.configPackService.findAll(vertical);
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.configPackService.findById(id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() updates: Record<string, unknown>) {
    return this.configPackService.update(id, updates);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.configPackService.delete(id);
  }

  // ========== VERSION MANAGEMENT ==========

  @Post(':id/promote')
  async promoteVersion(
    @Param('id') id: string,
    @Body() body: { version: string; userId?: string },
  ) {
    return this.configPackService.promoteVersion(
      id,
      body.version,
      body.userId || 'system',
    );
  }

  @Put(':id/deactivate')
  async deactivate(@Param('id') id: string) {
    return this.configPackService.deactivate(id);
  }

  // ========== TENANT PINNING ==========

  @Post('pin/:tenantId')
  async pinToTenant(
    @Param('tenantId') tenantId: string,
    @Body() dto: PinConfigPackDto,
  ) {
    return this.configPackService.pinToTenant(tenantId, dto);
  }

  @Delete('pin/:tenantId/:configPackId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unpinFromTenant(
    @Param('tenantId') tenantId: string,
    @Param('configPackId') configPackId: string,
  ) {
    await this.configPackService.unpinFromTenant(tenantId, configPackId);
  }

  @Get('pin/:tenantId')
  async getTenantPins(@Param('tenantId') tenantId: string) {
    return this.configPackService.getTenantPins(tenantId);
  }

  @Get('effective/:tenantId/:code')
  async getTenantEffectiveConfig(
    @Param('tenantId') tenantId: string,
    @Param('code') code: string,
  ) {
    return this.configPackService.getTenantEffectiveConfig(tenantId, code);
  }

  // ========== PROMOTE ACROSS ENVIRONMENTS ==========

  @Post(':id/promote-all')
  async promoteToAllTenants(
    @Param('id') id: string,
    @Body() body: { version: string; userId?: string },
  ) {
    return this.configPackService.promoteToAllTenants(
      id,
      body.version,
      body.userId || 'system',
    );
  }
}