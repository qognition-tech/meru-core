import { Injectable, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from '../entities/tag.entity';

export interface CreateTagInput {
  tenantId: string;
  name: string;
  color?: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

@Injectable()
export class TagService {
  private readonly logger = new Logger(TagService.name);

  constructor(
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
  ) {}

  async create(input: CreateTagInput): Promise<Tag> {
    // Check for duplicate name within tenant
    const existing = await this.tagRepo.findOne({
      where: { tenantId: input.tenantId, name: input.name },
    });
    if (existing) {
      throw new ConflictException(`Tag "${input.name}" already exists`);
    }

    const tag = this.tagRepo.create({
      tenantId: input.tenantId,
      name: input.name,
      color: input.color || '#6366f1',
    });
    const saved = await this.tagRepo.save(tag);
    this.logger.log(`Tag created: ${saved.name} (${saved.id})`);
    return saved;
  }

  async findById(id: string, tenantId: string): Promise<Tag> {
    const tag = await this.tagRepo.findOne({ where: { id, tenantId } });
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async findByTenant(tenantId: string, search?: string): Promise<Tag[]> {
    const qb = this.tagRepo
      .createQueryBuilder('t')
      .where('t.tenantId = :tenantId', { tenantId })
      .orderBy('t.name', 'ASC');

    if (search) {
      qb.andWhere('t.name ILIKE :search', { search: `%${search}%` });
    }

    return qb.getMany();
  }

  async findByIds(ids: string[], tenantId: string): Promise<Tag[]> {
    if (!ids.length) return [];
    return this.tagRepo
      .createQueryBuilder('t')
      .where('t.tenantId = :tenantId', { tenantId })
      .andWhere('t.id IN (:...ids)', { ids })
      .getMany();
  }

  async update(id: string, tenantId: string, updates: UpdateTagInput): Promise<Tag> {
    const tag = await this.findById(id, tenantId);

    if (updates.name !== undefined && updates.name !== tag.name) {
      const duplicate = await this.tagRepo.findOne({
        where: { tenantId, name: updates.name },
      });
      if (duplicate) {
        throw new ConflictException(`Tag "${updates.name}" already exists`);
      }
      tag.name = updates.name;
    }

    if (updates.color !== undefined) tag.color = updates.color;

    return this.tagRepo.save(tag);
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const tag = await this.findById(id, tenantId);
    await this.tagRepo.remove(tag);
    this.logger.log(`Tag deleted: ${tag.name} (${id})`);
  }
}