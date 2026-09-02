import { NotFoundException } from '@nestjs/common';
import { TaskService } from './task.service';
import { TaskStatus } from './entities/task.entity';
import { Actor } from '../common/access';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * `getTask` used to take no `tenantId` at all — RLS confined the connection
 * to the tenant, but nothing confined the *user* inside it, so a `client`
 * token could fetch any task in the firm by id. `assertOwnedByOrTenant` is
 * the fix: `own` scope (a `client`, a bare `platform_admin`) is held to
 * `task.assignedTo === actor.id`, everyone else (`firm_admin`/`staff`, or
 * inside `runAsGod`) reaches the whole tenant unchanged.
 *
 * ImmiStack gives clients checklist tasks — start and complete their own —
 * so the positive case is asserted at least as hard as the negative one.
 * A regression here is not "a client saw one extra row", it is "a client's
 * own checklist silently stopped working".
 */
describe('TaskService — task-level authorisation', () => {
  const T = 't1';
  const TASK_ID = 'task-1';

  const STAFF: Actor = { id: 'staff-1', roles: [PlatformRole.STAFF] };
  const FIRM_ADMIN: Actor = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };
  const OWNER_CLIENT: Actor = { id: 'client-a', roles: [PlatformRole.CLIENT] };
  const OTHER_CLIENT: Actor = { id: 'client-b', roles: [PlatformRole.CLIENT] };
  const BARE_OPERATOR: Actor = { id: 'op-1', roles: [PlatformRole.PLATFORM_ADMIN] };

  function build(task: Record<string, unknown> | null) {
    const store: Record<string, unknown> = task ? { ...task } : {};
    const taskRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (!task) return null;
        if (where.id !== store.id) return null;
        if (where.tenantId !== undefined && where.tenantId !== store.tenantId) return null;
        return { ...store };
      }),
      save: jest.fn(async (t: any) => {
        Object.assign(store, t);
        return { ...store };
      }),
    };
    const commentRepo = {
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn(async (c: any) => c),
    };
    const service = new TaskService(
      taskRepo as any,
      commentRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, taskRepo, commentRepo };
  }

  const ownedTask = () => ({
    id: TASK_ID,
    tenantId: T,
    assignedTo: 'client-a',
    status: TaskStatus.TODO,
    comments: [],
  });

  describe('getTask', () => {
    it('a client reads their own assigned task', async () => {
      const { service } = build(ownedTask());
      const task = await service.getTask(TASK_ID, T, OWNER_CLIENT);
      expect(task.id).toBe(TASK_ID);
    });

    it('a client cannot read a task assigned to someone else, and gets 404', async () => {
      const { service } = build(ownedTask());
      await expect(service.getTask(TASK_ID, T, OTHER_CLIENT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a bare platform_admin is held to their own assignment, same as a client', async () => {
      const { service } = build(ownedTask());
      await expect(service.getTask(TASK_ID, T, BARE_OPERATOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('staff and firm_admin read any task in the tenant', async () => {
      const { service: forStaff } = build(ownedTask());
      await expect(forStaff.getTask(TASK_ID, T, STAFF)).resolves.toMatchObject({ id: TASK_ID });

      const { service: forAdmin } = build(ownedTask());
      await expect(forAdmin.getTask(TASK_ID, T, FIRM_ADMIN)).resolves.toMatchObject({
        id: TASK_ID,
      });
    });

    it('a nonexistent task is 404 for everyone, including staff', async () => {
      const { service } = build(null);
      await expect(service.getTask(TASK_ID, T, STAFF)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('startTask — a client starting their own checklist item', () => {
    it('succeeds for the assignee', async () => {
      const { service, taskRepo } = build(ownedTask());
      const started = await service.startTask(TASK_ID, T, OWNER_CLIENT);
      expect(started.status).toBe(TaskStatus.IN_PROGRESS);
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it('is refused for a task assigned to a different client, as 404', async () => {
      const { service } = build(ownedTask());
      await expect(service.startTask(TASK_ID, T, OTHER_CLIENT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('staff may start any task in the tenant', async () => {
      const { service } = build(ownedTask());
      const started = await service.startTask(TASK_ID, T, STAFF);
      expect(started.status).toBe(TaskStatus.IN_PROGRESS);
    });
  });

  describe('completeTask — a client completing their own checklist item', () => {
    it('succeeds for the assignee and records who completed it', async () => {
      const { service } = build(ownedTask());
      const completed = await service.completeTask(TASK_ID, T, OWNER_CLIENT);
      expect(completed.status).toBe(TaskStatus.DONE);
      expect(completed.completedBy).toBe(OWNER_CLIENT.id);
    });

    it('is refused for a task assigned to a different client, as 404', async () => {
      const { service } = build(ownedTask());
      await expect(service.completeTask(TASK_ID, T, OTHER_CLIENT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('staff may complete any task in the tenant', async () => {
      const { service } = build(ownedTask());
      const completed = await service.completeTask(TASK_ID, T, STAFF);
      expect(completed.status).toBe(TaskStatus.DONE);
      expect(completed.completedBy).toBe(STAFF.id);
    });
  });

  describe('addComment — a client commenting on their own task', () => {
    it('succeeds for the assignee', async () => {
      const { service, commentRepo } = build(ownedTask());
      await service.addComment(TASK_ID, T, OWNER_CLIENT, 'uploaded the payslip');
      expect(commentRepo.save).toHaveBeenCalled();
    });

    it('is refused for a task assigned to a different client, as 404', async () => {
      const { service } = build(ownedTask());
      await expect(
        service.addComment(TASK_ID, T, OTHER_CLIENT, 'snooping'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('staff may comment on any task', async () => {
      const { service, commentRepo } = build(ownedTask());
      await service.addComment(TASK_ID, T, STAFF, 'checked in with the client');
      expect(commentRepo.save).toHaveBeenCalled();
    });
  });
});
