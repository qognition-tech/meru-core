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

  // A client token used to list every thread in the firm and read any of them.
  // RLS separates tenants, not the applicants inside one, so these are the only
  // checks standing between two of the same firm's clients.
  describe('client-role confinement', () => {
    it('splits the counterparty on the first colon only', () => {
      expect(service.counterpartyOf('email:jane@example.com')).toBe(
        'jane@example.com',
      );
      // A key whose tail contains a colon must survive intact, or two
      // counterparties collapse into one thread.
      expect(service.counterpartyOf('sms:+1:555')).toBe('+1:555');
    });

    it('filters the thread list to the caller when a counterparty is given', async () => {
      repo.query.mockReset();
      repo.query.mockResolvedValueOnce([{ count: 1 }]).mockResolvedValueOnce([]);
      await service.listThreads('t1', { counterparty: 'Jane@Example.com' });

      const [sql, params] = repo.query.mock.calls[0];
      expect(sql).toContain('position(\':\' in n."threadKey")');
      // Case-folded to match `deriveKey`, or a client with a capitalised
      // address silently sees nothing.
      expect(params).toContain('jane@example.com');
    });

    it('does not filter for staff, who see the whole firm', async () => {
      repo.query.mockReset();
      repo.query.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);
      await service.listThreads('t1', { counterparty: null });

      const [sql] = repo.query.mock.calls[0];
      expect(sql).not.toContain('position');
    });

    it("404s on another client's thread rather than 403", async () => {
      // 403 would confirm the thread exists, and the key *is* the other
      // client's email address.
      await expect(
        service.getThread('t1', 'email:someone-else@example.com', {
          counterparty: 'jane@example.com',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('lets a client read their own thread', async () => {
      repo.findAndCount.mockResolvedValueOnce([[], 0]);
      const out = await service.getThread('t1', 'email:jane@example.com', {
        counterparty: 'Jane@Example.com',
      });
      expect(out.counterparty).toBe('jane@example.com');
    });

    it('refuses to mark another client\'s thread read', async () => {
      await expect(
        service.markRead('t1', 'email:someone-else@example.com', 'jane@example.com'),
      ).rejects.toThrow(/not found/i);
    });

    it('threads a client message on their own address, not the firm\'s', async () => {
      // The reverse of the read leak: keyed on the firm's address, every client
      // writing in would land in one thread and read each other's mail.
      await service.send({
        tenantId: 't1',
        senderId: 'client-user',
        channel: NotificationType.EMAIL,
        to: 'firm@example.com',
        subject: 'Question',
        content: 'Any news?',
        asCounterparty: 'jane@example.com',
      });
      expect(saved[0].threadKey).toBe('email:jane@example.com');
      expect(saved[0].direction).toBe('inbound');
    });

    it('ignores a threadKey a client tries to aim elsewhere', async () => {
      await service.send({
        tenantId: 't1',
        senderId: 'client-user',
        channel: NotificationType.EMAIL,
        to: 'someone-else@example.com',
        subject: 'Question',
        content: 'Any news?',
        threadKey: 'email:someone-else@example.com',
        asCounterparty: 'jane@example.com',
      });
      expect(saved[0].threadKey).toBe('email:jane@example.com');
    });

    it('does not queue a client message for delivery back to themselves', async () => {
      await service.send({
        tenantId: 't1',
        senderId: 'client-user',
        channel: NotificationType.EMAIL,
        subject: 'Question',
        content: 'Any news?',
        asCounterparty: 'jane@example.com',
      });
      expect(saved[0].status).toBe('delivered');
    });
  });
});
