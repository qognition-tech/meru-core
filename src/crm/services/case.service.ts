import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Case, CaseStatus, CasePriority } from '../entities/case.entity';

export interface CreateCaseInput {
  tenantId: string;
  title: string;
  description?: string;
  caseType: string;
  priority?: CasePriority;
  assignedTo?: string;
  caseData?: Record<string, any>;
  metadata?: Record<string, any>;
  dueDate?: Date;
}

export interface TransitionCaseInput {
  targetStatus: CaseStatus;
  comment?: string;
}

@Injectable()
export class CaseService {
  private readonly logger = new Logger(CaseService.name);

  constructor(
    @InjectRepository(Case)
    private readonly caseRepo: Repository<Case>,
  ) {}

  async create(input: CreateCaseInput, createdBy: string): Promise<Case> {
    const kase = this.caseRepo.create({
      tenantId: input.tenantId,
      title: input.title,
      description: input.description || '',
      caseType: input.caseType,
      status: CaseStatus.OPEN,
      priority: input.priority || CasePriority.MEDIUM,
      assignedTo: input.assignedTo,
      caseData: input.caseData || {},
      metadata: input.metadata || {},
      dueDate: input.dueDate,
      createdBy,
    });
    return this.caseRepo.save(kase);
  }

  async findById(id: string, tenantId: string): Promise<Case> {
    const kase = await this.caseRepo.findOne({
      where: { id, tenantId },
      relations: ['assignee', 'creator'],
    });
    if (!kase) throw new NotFoundException('Case not found');
    return kase;
  }

  async findByTenant(tenantId: string, filters?: {
    status?: CaseStatus;
    priority?: CasePriority;
    assignedTo?: string;
    caseType?: string;
    search?: string;
  }): Promise<Case[]> {
    const qb = this.caseRepo.createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .leftJoinAndSelect('c.assignee', 'u')
      .leftJoinAndSelect('c.creator', 'cr');

    if (filters?.status) qb.andWhere('c.status = :status', { status: filters.status });
    if (filters?.priority) qb.andWhere('c.priority = :priority', { priority: filters.priority });
    if (filters?.assignedTo) qb.andWhere('c.assignedTo = :assignedTo', { assignedTo: filters.assignedTo });
    if (filters?.caseType) qb.andWhere('c.caseType = :caseType', { caseType: filters.caseType });
    if (filters?.search) {
      qb.andWhere('(c.title ILIKE :search OR c.description ILIKE :search)', {
        search: `%${filters.search}%`,
      });
    }

    return qb.orderBy('c.updatedAt', 'DESC').getMany();
  }

  async update(id: string, tenantId: string, updates: Partial<CreateCaseInput>): Promise<Case> {
    const kase = await this.findById(id, tenantId);
    if (updates.title !== undefined) kase.title = updates.title;
    if (updates.description !== undefined) kase.description = updates.description;
    if (updates.caseType !== undefined) kase.caseType = updates.caseType;
    if (updates.priority !== undefined) kase.priority = updates.priority;
    if (updates.assignedTo !== undefined) kase.assignedTo = updates.assignedTo;
    if (updates.caseData !== undefined) {
      kase.caseData = { ...kase.caseData, ...updates.caseData };
    }
    if (updates.metadata !== undefined) {
      kase.metadata = { ...kase.metadata, ...updates.metadata };
    }
    if (updates.dueDate !== undefined) kase.dueDate = updates.dueDate;
    return this.caseRepo.save(kase);
  }

  async transitionStatus(id: string, tenantId: string, transition: TransitionCaseInput): Promise<Case> {
    const kase = await this.findById(id, tenantId);
    kase.status = transition.targetStatus;

    if (transition.targetStatus === CaseStatus.RESOLVED || transition.targetStatus === CaseStatus.CLOSED) {
      kase.resolvedAt = new Date();
    }

    return this.caseRepo.save(kase);
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const kase = await this.findById(id, tenantId);
    await this.caseRepo.softRemove(kase);
  }
}
