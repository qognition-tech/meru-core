import { TaskService } from './task.service';
import { TaskStatus } from './entities/task.entity';

/**
 * `listTasks` (line 174) clamps a caller-supplied `limit` to
 * `Math.min(200, Math.max(1, Number(limit) || 50))`. `getMyWork`, two methods
 * further down in the same file, did `take: options.limit || 50` with no
 * upper bound — a caller passing a very large `limit` would get every
 * matching row back, plus the eager `relations: ['comments']` on each one.
 *
 * `TaskController.getMyWork` does not currently read `?limit=` off the query
 * string at all, so this was not reachable over HTTP at the time of writing —
 * this suite pins the service-level clamp directly so the method is safe the
 * moment something (a future route, an internal caller) does pass a `limit`
 * through, the same discipline `crm-authz.spec.ts` and
 * `workflow-list-scoping.spec.ts` apply to their own bug classes.
 */
describe('TaskService.getMyWork — the limit clamp', () => {
  const T = 't1';
  const USER = 'user-1';

  function buildTasks(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `t-${i}`,
      tenantId: T,
      assignedTo: USER,
      status: TaskStatus.TODO,
      priority: 1,
      dueDate: null,
    }));
  }

  function buildService(available: number) {
    const all = buildTasks(available);
    let takeValue: number | undefined;

    const taskRepo = {
      find: jest.fn(async ({ take }: any) => {
        takeValue = take;
        return all.slice(0, take);
      }),
      createQueryBuilder: () => ({
        select: () => ({
          addSelect: () => ({
            where: () => ({
              andWhere: () => ({
                groupBy: () => ({
                  getRawMany: async () => [],
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const service = new TaskService(
      taskRepo as any,
      {} as any, // commentRepo
      {} as any, // recurringJobRepo
      {} as any, // searchService
      {} as any, // aiService
      {} as any, // documentHubService
    );

    return { service, getTake: () => takeValue };
  }

  it('defaults to 50 when no limit is given', async () => {
    const { service, getTake } = buildService(300);
    await service.getMyWork(T, USER);
    expect(getTake()).toBe(50);
  });

  it('honours a limit under the cap', async () => {
    const { service, getTake } = buildService(300);
    await service.getMyWork(T, USER, { limit: 20 });
    expect(getTake()).toBe(20);
  });

  it('clamps a limit far past the cap to 200, the same bound listTasks uses', async () => {
    const { service, getTake } = buildService(999_999);
    await service.getMyWork(T, USER, { limit: 999_999 });
    expect(getTake()).toBe(200);
  });

  it('clamps a negative limit up to 1 rather than passing it through as "no limit"', async () => {
    const { service, getTake } = buildService(10);
    await service.getMyWork(T, USER, { limit: -5 });
    expect(getTake()).toBe(1);
  });

  it('treats a limit of 0 as unset, same as listTasks\'s identical clamp — falls back to the default 50', async () => {
    const { service, getTake } = buildService(300);
    await service.getMyWork(T, USER, { limit: 0 });
    expect(getTake()).toBe(50);
  });
});
