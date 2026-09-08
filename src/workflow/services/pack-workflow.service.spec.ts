import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PackWorkflowService } from './pack-workflow.service';
import { Workflow, WorkflowStatus } from '../entities/workflow.entity';
import { WorkflowEngineService } from '../workflow.service';
import { VerticalPackService } from '../../tenant/services/vertical-pack.service';

describe('PackWorkflowService', () => {
  const sectionWithPack = jest.fn();
  const createWorkflow = jest.fn();
  const getOne = jest.fn();
  const update = jest.fn();
  const qb = {
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    getOne,
  };
  let service: PackWorkflowService;

  const packWorkflow = {
    id: '482-tss',
    name: '482 TSS',
    entityType: 'case',
    steps: [
      {
        id: 'intake',
        name: 'Intake',
        type: 'form',
        assignedRole: 'case_coordinator',
        slaHours: 24,
        transitions: [{ to: 'review', label: 'Proceed' }],
      },
      {
        id: 'review',
        name: 'Review',
        type: 'review',
        transitions: [
          { to: 'lodged', label: 'Lodge', condition: "matter.subclass in ['482']" },
          { to: 'intake', label: 'Back', condition: 'process.exit()' },
        ],
      },
      { id: 'lodged', name: 'Lodged', type: 'decision' },
    ],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    getOne.mockResolvedValue(null);
    createWorkflow.mockResolvedValue({ id: 'wf-1' });
    sectionWithPack.mockResolvedValue({
      pack: { code: 'immigration', version: '2.3.0' },
      section: [packWorkflow],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        PackWorkflowService,
        {
          provide: getRepositoryToken(Workflow),
          useValue: { createQueryBuilder: () => qb, update },
        },
        { provide: WorkflowEngineService, useValue: { createWorkflow } },
        { provide: VerticalPackService, useValue: { sectionWithPack, list: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(PackWorkflowService);
  });

  it('materialises a pack workflow into states and transitions, and activates it', async () => {
    const report = await service.materialise('t1', 'immigration', 'u1');

    expect(report.created).toEqual([{ packWorkflowId: '482-tss', workflowId: 'wf-1' }]);
    expect(update).toHaveBeenCalledWith('wf-1', { status: WorkflowStatus.ACTIVE });

    const def = createWorkflow.mock.calls[0][1];
    expect(def.states.map((s: any) => [s.name, s.type])).toEqual([
      ['intake', 'start'],
      ['review', 'intermediate'],
      ['lodged', 'end'],
    ]);
    expect(def.triggerConfig.pack).toEqual({
      code: 'immigration',
      version: '2.3.0',
      workflowId: '482-tss',
    });

    const lodge = def.transitions.find((t: any) => t.name === 'Lodge');
    expect(lodge.type).toBe('conditional');
    expect(lodge.conditions.jsonLogic).toEqual({
      in: [{ var: 'matter.subclass' }, ['482']],
    });
    expect(lodge.permissions).toEqual({});
  });

  it('stores an uncompilable condition as unevaluable and reports it', async () => {
    const report = await service.materialise('t1', 'immigration', 'u1');
    const def = createWorkflow.mock.calls[0][1];
    const back = def.transitions.find((t: any) => t.name === 'Back');
    expect(back.conditions.unevaluable).toMatch(/unsupported/);
    expect(back.conditions.jsonLogic).toBeUndefined();
    expect(report.unevaluableConditions).toEqual([
      expect.objectContaining({ packWorkflowId: '482-tss', from: 'review', to: 'intake' }),
    ]);
  });

  it('is idempotent — a second call reports existing and creates nothing', async () => {
    getOne.mockResolvedValue({ id: 'wf-existing' });
    const report = await service.materialise('t1', 'immigration', 'u1');
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(report.existing).toEqual([{ packWorkflowId: '482-tss', workflowId: 'wf-existing' }]);
  });

  it('is empty for a vertical with no pack', async () => {
    sectionWithPack.mockResolvedValue({ pack: null, section: null });
    const report = await service.materialise('t1', 'labour', 'u1');
    expect(report).toEqual({ pack: null, created: [], existing: [], unevaluableConditions: [] });
  });
});
