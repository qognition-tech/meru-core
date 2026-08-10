import { ThreadService } from './thread.service';
import { NotificationType } from './entities/notification.entity';

describe('ThreadService — one conversation per counterparty', () => {
  const saved: Record<string, any>[] = [];
  const repo = {
    create: (x: Record<string, any>) => x,
    save: (x: Record<string, any>) => {
      saved.push(x);
      return Promise.resolve({ ...x, id: 'n1' });
    },
    query: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const service = new ThreadService(repo as any);

  beforeEach(() => saved.splice(0));

  it('folds case, so one person is not two threads', () => {
    expect(service.deriveKey(NotificationType.EMAIL, 'Jane@Firm.com ')).toBe(
      'email:jane@firm.com',
    );
  });

  it('keys per channel — an email and an SMS to one person are two threads', () => {
    expect(service.deriveKey(NotificationType.EMAIL, 'j@x.com')).not.toBe(
      service.deriveKey(NotificationType.SMS, 'j@x.com'),
    );
  });

  it('matches the migration backfill exactly', () => {
    // The backfill is `"type" || ':' || lower(email|phone|recipientId)`. If
    // these two derivations drift, imported history and new replies land in
    // different threads and the split is invisible.
    const backfill = (type: string, recipient: string) =>
      `${type}:${recipient.toLowerCase()}`;
    expect(service.deriveKey(NotificationType.EMAIL, 'A@B.com')).toBe(
      backfill('email', 'A@B.com'),
    );
  });

  it('derives the key when the caller does not supply one', async () => {
    await service.send({
      tenantId: 't1',
      senderId: 'u1',
      channel: NotificationType.EMAIL,
      to: 'client@example.com',
      subject: 'Hi',
      content: 'Body',
    });
    expect(saved[0].threadKey).toBe('email:client@example.com');
    expect(saved[0].direction).toBe('outbound');
    expect(saved[0].status).toBe('pending');
    expect(saved[0].recipientEmail).toBe('client@example.com');
  });

  it('refuses a threadKey that disagrees with the recipient', async () => {
    await expect(
      service.send({
        tenantId: 't1',
        senderId: 'u1',
        channel: NotificationType.EMAIL,
        to: 'client@example.com',
        subject: 'Hi',
        content: 'Body',
        threadKey: 'email:someone-else@example.com',
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects an empty recipient rather than filing a message nobody can reply to', async () => {
    await expect(
      service.send({
        tenantId: 't1',
        senderId: 'u1',
        channel: NotificationType.EMAIL,
        to: '   ',
        subject: 'Hi',
        content: 'Body',
      }),
    ).rejects.toThrow(/recipient address is required/);
  });

  it('records who sent it', async () => {
    await service.send({
      tenantId: 't1',
      senderId: 'user-42',
      channel: NotificationType.EMAIL,
      to: 'client@example.com',
      subject: 'Hi',
      content: 'Body',
    });
    expect(saved[0].metadata.customData.sentByUserId).toBe('user-42');
  });

  it('puts an SMS number in the phone column, not the email column', async () => {
    await service.send({
      tenantId: 't1',
      senderId: 'u1',
      channel: NotificationType.SMS,
      to: '+971500000000',
      subject: 'Hi',
      content: 'Body',
    });
    expect(saved[0].recipientPhone).toBe('+971500000000');
    expect(saved[0].recipientEmail).toBeNull();
  });
});
