import { NotificationDispatchService } from './notification-dispatch.service';
import {
  NotificationStatus,
  NotificationType,
} from './entities/notification.entity';

/**
 * The dispatcher's failure mode is not "one message did not send" — it is "no
 * message sent, anywhere, for a day and a half", which is what happened when a
 * single row threw inside the loop. These tests exist to keep one bad row from
 * ever costing more than itself.
 */
describe('NotificationDispatchService — one bad row is not an outage', () => {
  const row = (over: Record<string, any> = {}) => ({
    id: over.id ?? 'n1',
    tenantId: 't1',
    type: NotificationType.EMAIL,
    status: NotificationStatus.PENDING,
    subject: 'Subject',
    content: 'Body',
    recipientId: 'd1a5d1a4-6741-41c8-80cc-f49d5f3712df',
    recipientEmail: null,
    threadKey: null,
    metadata: {},
    deliveryAttempts: [],
    retryCount: 0,
    ...over,
  });

  const build = (rows: Record<string, any>[], userEmail: string | null = null) => {
    const saved: Record<string, any>[] = [];
    const notificationRepo = {
      find: jest.fn().mockResolvedValue(rows),
      save: jest.fn((x: Record<string, any>) => {
        saved.push({ ...x });
        return Promise.resolve(x);
      }),
    };
    const userRepo = {
      findOne: jest.fn().mockResolvedValue(userEmail ? { id: 'u', email: userEmail } : null),
    };
    const mailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    const service = new NotificationDispatchService(
      notificationRepo as any,
      userRepo as any,
      mailService as any,
    );
    return { service, saved, notificationRepo, userRepo, mailService };
  };

  it('prefers the address column over a user lookup', async () => {
    const { service, mailService, userRepo } = build([
      row({ recipientEmail: 'jane@example.com' }),
    ]);
    await service.dispatchPending();

    expect(mailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane@example.com' }),
    );
    // No reason to touch `users` when the row already carries the address —
    // and most counterparties have no user row at all.
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('never queries users with a value a uuid column cannot hold', async () => {
    // `ThreadService.send` writes the counterparty's address into the varchar
    // `recipientId`. Passing that to `users.id` (uuid) is what threw
    // `invalid input syntax for type uuid` and killed every sweep.
    const { service, userRepo, mailService } = build([
      row({ recipientId: 'Jane@Example.com', recipientEmail: null }),
    ]);
    await service.dispatchPending();

    expect(userRepo.findOne).not.toHaveBeenCalled();
    expect(mailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'Jane@Example.com' }),
    );
  });

  it('still resolves a genuine user id through users', async () => {
    const { service, userRepo, mailService } = build(
      [row()],
      'user@firm.com',
    );
    await service.dispatchPending();

    expect(userRepo.findOne).toHaveBeenCalled();
    expect(mailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@firm.com' }),
    );
  });

  it('fails only the throwing row and delivers the rest', async () => {
    const { service, saved, mailService } = build([
      row({ id: 'poison', recipientEmail: 'boom@example.com' }),
      row({ id: 'good', recipientEmail: 'fine@example.com' }),
    ]);
    mailService.send.mockImplementation(({ to }: { to: string }) =>
      to === 'boom@example.com'
        ? Promise.reject(new Error('invalid input syntax for type uuid'))
        : Promise.resolve({ delivered: true }),
    );

    const result = await service.dispatchPending();

    // The whole point: the batch completed.
    expect(result.processed).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(1);
    // And the poison row is parked, so the next sweep is not blocked by it.
    const poison = saved.find((s) => s.id === 'poison');
    expect(poison?.status).toBe(NotificationStatus.FAILED);
  });

  it('continues even when parking the bad row also fails', async () => {
    const { service, notificationRepo, mailService } = build([
      row({ id: 'poison', recipientEmail: 'boom@example.com' }),
      row({ id: 'good', recipientEmail: 'fine@example.com' }),
    ]);
    mailService.send.mockImplementation(({ to }: { to: string }) =>
      to === 'boom@example.com'
        ? Promise.reject(new Error('transport exploded'))
        : Promise.resolve({ delivered: true }),
    );
    notificationRepo.save.mockImplementation((x: Record<string, any>) =>
      x.id === 'poison'
        ? Promise.reject(new Error('and the write failed too'))
        : Promise.resolve(x),
    );

    await expect(service.dispatchPending()).resolves.toMatchObject({
      processed: 2,
      delivered: 1,
    });
  });

  it('marks an in-app notification delivered without a transport', async () => {
    const { service, saved, mailService } = build([
      row({ type: NotificationType.IN_APP }),
    ]);
    const result = await service.dispatchPending();

    expect(mailService.send).not.toHaveBeenCalled();
    expect(saved[0].status).toBe(NotificationStatus.DELIVERED);
    expect(result.skipped).toBe(1);
  });

  it('records a recipient with no resolvable address as failed, not delivered', async () => {
    const { service, saved } = build([
      row({ recipientId: 'not-a-uuid-and-not-an-address', recipientEmail: null }),
    ]);
    const result = await service.dispatchPending();

    expect(result.failed).toBe(1);
    expect(saved[0].status).toBe(NotificationStatus.FAILED);
  });
});
