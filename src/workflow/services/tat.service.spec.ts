import { TatService } from './tat.service';
import { InstanceStatus } from '../entities/workflow-instance.entity';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/**
 * TAT is derived from the transition history, so the tests that matter are
 * about what the derivation refuses to claim: an open stage is not a
 * turnaround, and a stage with no SLA has not "met" one.
 */
describe('TatService', () => {
  const instance = {
    id: 'i1',
    tenantId: 't1',
    workflowId: 'wf1',
    entityType: 'case',
    entityId: 'e1',
    status: InstanceStatus.ACTIVE,
    createdAt: hoursAgo(100),
    completedAt: null,
    stateEnteredAt: hoursAgo(10),
    currentState: { name: 'review', config: { slaHours: 4 } },
    workflow: { slaConfig: { enabled: true } },
    history: [
      { timestamp: hoursAgo(70), fromState: 'intake', toState: 'documents' },
      { timestamp: hoursAgo(10), fromState: 'documents', toState: 'review' },
    ],
  };

  const repo = {
    findOne: jest.fn().mockResolvedValue(instance),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        take: () => qb,
        getMany: () => Promise.resolve([instance]),
      };
      return qb;
    }),
  };

  const service = new TatService(repo as any);

  it('measures each closed stage from the previous transition', async () => {
    const tat = await service.forInstance('t1', 'i1');
    expect(tat.stages[0]).toMatchObject({ stage: 'intake', hours: 30, open: false });
    expect(tat.stages[1]).toMatchObject({ stage: 'documents', hours: 60, open: false });
  });

  it('marks the stage the record is sitting in as open', async () => {
    const tat = await service.forInstance('t1', 'i1');
    const current = tat.stages[tat.stages.length - 1];
    expect(current).toMatchObject({ stage: 'review', open: true, exitedAt: null });
    expect(current.hours).toBeCloseTo(10, 1);
  });

  it('flags an open stage already past its SLA as breached', async () => {
    const tat = await service.forInstance('t1', 'i1');
    // 10 hours in a 4-hour stage. Waiting for it to close before admitting the
    // breach would report a clean SLA for exactly as long as it is being missed.
    expect(tat.stages[tat.stages.length - 1].breached).toBe(true);
  });

  it('reports a stage with no declared SLA as unknown, not as met', async () => {
    const tat = await service.forInstance('t1', 'i1');
    expect(tat.stages[0].slaHours).toBeNull();
    expect(tat.stages[0].breached).toBeNull();
  });

  it('excludes open stages from the aggregate', async () => {
    const agg = await service.aggregate('t1', {});
    // intake and documents have closed; review has not, so it contributes
    // nothing to an average of how long the stage takes.
    expect(agg.stages.map((s) => s.stage).sort()).toEqual(['documents', 'intake']);
  });

  it('reports median and p90 next to the mean', async () => {
    const agg = await service.aggregate('t1', {});
    const documents = agg.stages.find((s) => s.stage === 'documents')!;
    expect(documents).toMatchObject({ entries: 1, meanHours: 60, medianHours: 60, p90Hours: 60 });
  });

  it('has no overall figure until something completes', async () => {
    const agg = await service.aggregate('t1', {});
    expect(agg.overall).toBeNull();
  });

  it('404s an instance belonging to another tenant', async () => {
    repo.findOne.mockResolvedValueOnce(null);
    await expect(service.forInstance('t2', 'i1')).rejects.toThrow(
      /No workflow instance/,
    );
  });
});
