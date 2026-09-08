import { ForbiddenException } from '@nestjs/common';
import { IamService } from './iam.service';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';
import type { Actor } from '../common/access';

/**
 * `POST /iam/users/invite` and `PATCH /iam/users/:id` are both reachable by
 * `firm_admin` (tenant-scoped), but `InviteUserDto.role` / `UpdateUserDto.role`
 * validate only `@IsEnum(PlatformRole)`, which admits `platform_admin`. Before
 * `canGrantRole`, a `firm_admin` could invite a `platform_admin` colleague, or
 * PATCH their own row straight into one — and `platform_admin` passes every
 * `@Roles(PLATFORM_ADMIN)` route: God View, tenant provisioning,
 * `TenancyService.runAsGod` cross-tenant reads. None of that is RLS's job to
 * catch — `runAsGod` bypasses tenancy by design.
 *
 * `PATCH /iam/users/:id` also used to be `@Roles(PLATFORM_ADMIN, FIRM_ADMIN)`
 * outright, so a `staff` or `client` editing their own name got a flat 403 —
 * every portal's `ProfileView` calls this route against the caller's own id.
 * The self-edit exception is asserted here alongside the escalation fix
 * because they are the same method (`IamService.updateUser`) and a change to
 * one is exactly the kind of edit that could silently reopen the other.
 */
describe('IamService — role-escalation guard', () => {
  const T = 'tenant-1';

  function buildIamService() {
    // Keyed store rather than a bare array, so `findOne({ where: { email }})`
    // (the invite uniqueness check) and `findOne({ where: { id, tenantId }})`
    // (the update lookup) can share one fake repo, matching how the real
    // `Repository<User>.findOne` answers both shapes.
    const users: Array<Record<string, any>> = [];

    const userRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.email !== undefined) {
          const match = users.find((u) => u.email === where.email);
          return match ? { ...match } : null;
        }
        const match = users.find(
          (u) =>
            u.id === where.id &&
            (where.tenantId === undefined || u.tenantId === where.tenantId),
        );
        return match ? { ...match } : null;
      }),
      create: jest.fn((x: any) => ({ id: `new-${users.length + 1}`, ...x })),
      save: jest.fn(async (u: any) => {
        const idx = users.findIndex((x) => x.id === u.id);
        if (idx === -1) users.push({ ...u });
        else users[idx] = { ...u };
        return u;
      }),
    };
    const tenantRepo = {
      findOne: jest.fn(async () => ({ id: T, name: 'Acme' })),
    };
    const authTokenRepo = {
      update: jest.fn(async () => ({ affected: 0 })),
      save: jest.fn(async (t: any) => t),
      create: jest.fn((x: any) => x),
    };
    const mailService = {
      sendInvite: jest.fn(async () => ({ delivered: true })),
    };

    const service = new IamService(
      userRepo as any,
      tenantRepo as any,
      {} as any,
      {} as any,
      {} as any,
      authTokenRepo as any,
      {} as any,
      mailService as any,
    );

    return { service, userRepo, users };
  }

  function seedUser(users: Array<Record<string, any>>, overrides: Record<string, any>) {
    users.push({
      tenantId: T,
      email: `${overrides.id}@acme.test`,
      firstName: 'Original',
      lastName: 'Name',
      attributes: {},
      status: UserStatus.ACTIVE,
      ...overrides,
    });
  }

  describe('inviteUser', () => {
    it('firm_admin CANNOT invite a platform_admin', async () => {
      const { service, userRepo } = buildIamService();
      await expect(
        service.inviteUser(
          T,
          { email: 'wannabe@acme.test', role: PlatformRole.PLATFORM_ADMIN },
          undefined,
          [PlatformRole.FIRM_ADMIN],
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Checked before any lookup: a caller who cannot grant the role should
      // not even learn whether that email is already taken.
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('firm_admin CAN invite staff and client', async () => {
      const { service } = buildIamService();
      await expect(
        service.inviteUser(
          T,
          { email: 'new-staff@acme.test', role: PlatformRole.STAFF },
          undefined,
          [PlatformRole.FIRM_ADMIN],
        ),
      ).resolves.toMatchObject({ role: PlatformRole.STAFF });

      await expect(
        service.inviteUser(
          T,
          { email: 'new-client@acme.test', role: PlatformRole.CLIENT },
          undefined,
          [PlatformRole.FIRM_ADMIN],
        ),
      ).resolves.toMatchObject({ role: PlatformRole.CLIENT });
    });

    it('platform_admin CAN invite a platform_admin', async () => {
      const { service } = buildIamService();
      await expect(
        service.inviteUser(
          T,
          { email: 'colleague@meru.internal', role: PlatformRole.PLATFORM_ADMIN },
          undefined,
          [PlatformRole.PLATFORM_ADMIN],
        ),
      ).resolves.toMatchObject({ role: PlatformRole.PLATFORM_ADMIN });
    });
  });

  describe('updateUser — role ceiling', () => {
    it('firm_admin CANNOT PATCH themselves to platform_admin', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] });
      const actor: Actor = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };

      await expect(
        service.updateUser(
          T,
          'admin-1',
          { role: PlatformRole.PLATFORM_ADMIN },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('updateUser — status ceiling', () => {
    // Only `role` went through `canGrantRole`; `status` did not. A
    // `firm_admin` could suspend or deactivate a `platform_admin`'s account
    // in their own tenant even though the same caller could never grant
    // that role — account standing tampered with across the exact
    // privilege boundary the role check already closed.
    it('firm_admin CANNOT suspend a platform_admin colleague\'s account', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'super-1', roles: [PlatformRole.PLATFORM_ADMIN] });
      const actor: Actor = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };

      await expect(
        service.updateUser(
          T,
          'super-1',
          { status: UserStatus.INACTIVE },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('firm_admin CANNOT reactivate a locked platform_admin account either — the ceiling is symmetric', async () => {
      const { service, users } = buildIamService();
      seedUser(users, {
        id: 'super-2',
        roles: [PlatformRole.PLATFORM_ADMIN],
        status: UserStatus.LOCKED,
      });
      const actor: Actor = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };

      await expect(
        service.updateUser(T, 'super-2', { status: UserStatus.ACTIVE }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('firm_admin CAN still suspend a staff member — the ceiling does not overreach', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'staff-1', roles: [PlatformRole.STAFF] });
      const actor: Actor = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };

      const updated = await service.updateUser(
        T,
        'staff-1',
        { status: UserStatus.INACTIVE },
        actor,
      );
      expect(updated.status).toBe(UserStatus.INACTIVE);
    });

    it('platform_admin CAN suspend another platform_admin', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'super-1', roles: [PlatformRole.PLATFORM_ADMIN] });
      const actor: Actor = {
        id: 'super-0',
        roles: [PlatformRole.PLATFORM_ADMIN],
      };

      const updated = await service.updateUser(
        T,
        'super-1',
        { status: UserStatus.INACTIVE },
        actor,
      );
      expect(updated.status).toBe(UserStatus.INACTIVE);
    });
  });

  describe('updateUser — self-service by a non-admin', () => {
    it('a client CAN self-edit their own name', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'client-1', roles: [PlatformRole.CLIENT] });
      const actor: Actor = { id: 'client-1', roles: [PlatformRole.CLIENT] };

      const updated = await service.updateUser(
        T,
        'client-1',
        { firstName: 'Layla' },
        actor,
      );
      expect(updated.firstName).toBe('Layla');
    });

    it('a client CANNOT self-edit their own role or status', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'client-2', roles: [PlatformRole.CLIENT] });
      const actor: Actor = { id: 'client-2', roles: [PlatformRole.CLIENT] };

      await expect(
        service.updateUser(T, 'client-2', { role: PlatformRole.STAFF }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        service.updateUser(
          T,
          'client-2',
          { status: UserStatus.INACTIVE },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a client CANNOT edit a different user at all, self-edit or not', async () => {
      const { service, users } = buildIamService();
      seedUser(users, { id: 'client-3', roles: [PlatformRole.CLIENT] });
      seedUser(users, { id: 'client-4', roles: [PlatformRole.CLIENT] });
      const actor: Actor = { id: 'client-3', roles: [PlatformRole.CLIENT] };

      await expect(
        service.updateUser(T, 'client-4', { firstName: 'Snooping' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
