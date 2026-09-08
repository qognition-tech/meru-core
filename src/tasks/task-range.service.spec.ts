import { TaskService } from './task.service';
import { TaskStatus } from './entities/task.entity';
import { Actor } from '../common/access';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * Range filters that read like ranges and are not.
 *
 * `getCalendarEvents` filtered on `MoreThan(start) && LessThan(end)`. `&&`
 * evaluates to its right operand, so the expression *was* `LessThan(end)` and
 * the lower bound never existed — the endpoint answered "everything due before
 * the end of the window", silently including last year's tasks. `listTasks`
 * had the same fault by another route: `{ ...LessThan(x), $moreThan: y }`, where
 * `$moreThan` is Mongo syntax TypeORM ignores.
 *
 * Neither throws, neither logs, and both return a 200 with plausible-looking
 * data, which is why they survived. These tests read the generated `where`
 * clause rather than the results, because that is where the lie was.
 */
describe('TaskService — date ranges must bound both ends', () => {
  const build = () => {
    const taskRepo = {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const service = new TaskService(
      taskRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, taskRepo };
  };

  const from = new Date('2026-08-01T00:00:00Z');
  const to = new Date('2026-08-31T23:59:59Z');

  // Staff reach the whole tenant, which is what these range/pagination tests
  // are about — ownership narrowing (`assertOwnedByOrTenant`, the `'own'`
  // override in `listTasks`, the `scope: 'firm'` downgrade in
  // `getCalendarEvents`) is covered separately below.
  const STAFF: Actor = { id: 'staff-1', roles: [PlatformRole.STAFF] };
  const CLIENT: Actor = { id: 'u1', roles: [PlatformRole.CLIENT] };

  describe('listTasks', () => {
    it('bounds both ends when given both', async () => {
      const { service, taskRepo } = build();
      await service.listTasks(
        't1',
        { dueAfter: from, dueBefore: to },
        STAFF,
      );

      const { where } = taskRepo.findAndCount.mock.calls[0][0];
      // Between renders as a two-parameter operator; the old code produced a
      // one-sided LessThan with an inert `$moreThan` key alongside it.
      expect(where.dueDate.type).toBe('between');
      expect(where.dueDate.value).toEqual([from, to]);
    });

    it('still supports one bound alone', async () => {
      const { service, taskRepo } = build();
      await service.listTasks('t1', { dueBefore: to }, STAFF);
      expect(taskRepo.findAndCount.mock.calls[0][0].where.dueDate.type).toBe(
        'lessThan',
      );

      const second = build();
      await second.service.listTasks('t1', { dueAfter: from }, STAFF);
      expect(
        second.taskRepo.findAndCount.mock.calls[0][0].where.dueDate.type,
      ).toBe('moreThanOrEqual');
    });

    it('omits the date filter entirely when neither bound is given', async () => {
      const { service, taskRepo } = build();
      await service.listTasks('t1', { status: TaskStatus.TODO }, STAFF);
      expect(taskRepo.findAndCount.mock.calls[0][0].where.dueDate).toBeUndefined();
    });

    it("overrides a requested assignedTo with the caller's own id for a client", async () => {
      // A `client` asking for `?assignedTo=<someone-else>` used to get exactly
      // that other user's caseload back — see P0-1.
      const { service, taskRepo } = build();
      await service.listTasks('t1', { assignedTo: 'other-user' }, CLIENT);
      expect(taskRepo.findAndCount.mock.calls[0][0].where.assignedTo).toBe(
        'u1',
      );
    });

    it('leaves a staff-requested assignedTo alone', async () => {
      const { service, taskRepo } = build();
      await service.listTasks('t1', { assignedTo: 'someone' }, STAFF);
      expect(taskRepo.findAndCount.mock.calls[0][0].where.assignedTo).toBe(
        'someone',
      );
    });
  });

  describe('listTasks pagination', () => {
    it('defaults to 50 per page, matching /crm/entities', async () => {
      const { service, taskRepo } = build();
      const result = await service.listTasks('t1', {}, STAFF);

      expect(taskRepo.findAndCount.mock.calls[0][0].take).toBe(50);
      expect(taskRepo.findAndCount.mock.calls[0][0].skip).toBe(0);
      expect(result.limit).toBe(50);
      expect(result.page).toBe(1);
    });

    it('clamps limit to 200 rather than 400ing', async () => {
      // /payments rejects >100 outright and /tasks used to reject `limit` at all.
      // Clamping keeps a large request useful instead of failing it.
      const { service, taskRepo } = build();
      await service.listTasks('t1', { limit: 5000 }, STAFF);
      expect(taskRepo.findAndCount.mock.calls[0][0].take).toBe(200);
    });

    it('never issues a negative offset or an unbounded take', async () => {
      // A negative limit floors at 1 rather than falling back to 50, and page 0
      // becomes page 1. Both match `/crm/entities` exactly — the point of this
      // change is that the two endpoints agree, so the clamp is copied rather
      // than improved. What matters here is that neither value can reach
      // Postgres as a negative LIMIT/OFFSET.
      const { service, taskRepo } = build();
      await service.listTasks('t1', { page: 0, limit: -3 }, STAFF);
      const opts = taskRepo.findAndCount.mock.calls[0][0];
      expect(opts.skip).toBe(0);
      expect(opts.take).toBe(1);
    });

    it('offsets by page', async () => {
      const { service, taskRepo } = build();
      await service.listTasks('t1', { page: 3, limit: 20 }, STAFF);
      expect(taskRepo.findAndCount.mock.calls[0][0].skip).toBe(40);
    });

    it('reports the true total, not the page length', async () => {
      const { service, taskRepo } = build();
      taskRepo.findAndCount.mockResolvedValueOnce([[{ id: 'a' }], 417]);
      const result = await service.listTasks('t1', { limit: 1 }, STAFF);
      expect(result.total).toBe(417);
    });
  });

  describe('getCalendarEvents', () => {
    it('bounds the window at both ends', async () => {
      const { service, taskRepo } = build();
      await service.getCalendarEvents('t1', 'u1', STAFF, from, to);

      const { where } = taskRepo.find.mock.calls[0][0];
      expect(where.dueDate.type).toBe('between');
      expect(where.dueDate.value).toEqual([from, to]);
    });

    it("scopes to the caller by default", async () => {
      const { service, taskRepo } = build();
      await service.getCalendarEvents('t1', 'u1', STAFF, from, to);
      expect(taskRepo.find.mock.calls[0][0].where.assignedTo).toBe('u1');
    });

    it('returns the whole firm when asked, for a shared calendar', async () => {
      const { service, taskRepo } = build();
      await service.getCalendarEvents('t1', 'u1', STAFF, from, to, 'firm');

      const { where } = taskRepo.find.mock.calls[0][0];
      expect(where.assignedTo).toBeUndefined();
      // Still one tenant — widening the assignee must not widen the tenant.
      expect(where.tenantId).toBe('t1');
    });

    it("holds a client's scope=firm request to 'mine' rather than widening it", async () => {
      // See P0-1: `scope=firm` is a staff privilege, not something a
      // `client` token can request its way into.
      const { service, taskRepo } = build();
      await service.getCalendarEvents('t1', 'u1', CLIENT, from, to, 'firm');

      const { where } = taskRepo.find.mock.calls[0][0];
      expect(where.assignedTo).toBe('u1');
    });

    it('maps a task to an event with its due date at both ends', async () => {
      const { service, taskRepo } = build();
      taskRepo.find.mockResolvedValueOnce([
        {
          id: 'task-1',
          title: 'Collect payslips',
          description: null,
          dueDate: to,
          status: TaskStatus.TODO,
          priority: 'high',
        },
      ]);

      const events = await service.getCalendarEvents('t1', 'u1', STAFF, from, to);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'task-1',
        title: 'Collect payslips',
        start: to,
        end: to,
        type: 'task',
      });
    });
  });
});
