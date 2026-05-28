import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Note } from '../entities/note.entity';

export interface CreateNoteInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  content: string;
  isInternal?: boolean;
}

export interface UpdateNoteInput {
  content?: string;
  isInternal?: boolean;
}

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);

  constructor(
    @InjectRepository(Note)
    private readonly noteRepo: Repository<Note>,
  ) {}

  async create(input: CreateNoteInput, createdBy: string): Promise<Note> {
    const note = this.noteRepo.create({
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      content: input.content,
      isInternal: input.isInternal ?? false,
      createdBy,
    });
    return this.noteRepo.save(note);
  }

  async findById(id: string, tenantId: string): Promise<Note> {
    const note = await this.noteRepo.findOne({
      where: { id, tenantId },
      relations: ['creator'],
    });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }

  async findByEntity(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<Note[]> {
    return this.noteRepo.find({
      where: { tenantId, entityType, entityId },
      relations: ['creator'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByTenant(
    tenantId: string,
    filters?: { entityType?: string; isInternal?: boolean; search?: string },
  ): Promise<Note[]> {
    const qb = this.noteRepo
      .createQueryBuilder('n')
      .where('n.tenantId = :tenantId', { tenantId })
      .leftJoinAndSelect('n.creator', 'u')
      .orderBy('n.createdAt', 'DESC');

    if (filters?.entityType) {
      qb.andWhere('n.entityType = :entityType', { entityType: filters.entityType });
    }
    if (filters?.isInternal !== undefined) {
      qb.andWhere('n.isInternal = :isInternal', { isInternal: filters.isInternal });
    }
    if (filters?.search) {
      qb.andWhere('n.content ILIKE :search', { search: `%${filters.search}%` });
    }

    return qb.getMany();
  }

  async update(id: string, tenantId: string, updates: UpdateNoteInput): Promise<Note> {
    const note = await this.findById(id, tenantId);
    if (updates.content !== undefined) note.content = updates.content;
    if (updates.isInternal !== undefined) note.isInternal = updates.isInternal;
    return this.noteRepo.save(note);
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const note = await this.findById(id, tenantId);
    await this.noteRepo.remove(note);
    this.logger.log(`Note deleted: ${id}`);
  }
}