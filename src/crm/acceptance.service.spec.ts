import { AcceptanceService } from './acceptance.service';

/**
 * The frontend asked for e-signature and refused to build an approximation,
 * which was right: an approximation of a signature is worse than none, because
 * everyone downstream treats it as one.
 *
 * These tests pin the narrower thing that is actually true — an audited,
 * hash-anchored record of assent that says on its face it is not a signature.
 */
describe('AcceptanceService', () => {
  const build = (entity: Record<string, any> | null = { id: 'e1', tenantId: 't1', verticalAttributes: {} }) => {
    const saved: Record<string, any>[] = [];
    const entities = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn((e: Record<string, any>) => {
        saved.push(JSON.parse(JSON.stringify(e)));
        return Promise.resolve(e);
      }),
    };
    const audit = { logEvent: jest.fn().mockResolvedValue({}) };
    const service = new AcceptanceService(entities as any, audit as any);
    return { service, saved, audit, entities };
  };

  const input = {
    subject: 'cost_agreement',
    userId: 'u1',
    email: 'priya@example.com',
    ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  };

  it('never claims to be a signature', async () => {
    const { service } = build();
    const out = await service.record('t1', 'e1', input);
    expect(out.isSignature).toBe(false);
  });

  it('records who, when and from where', async () => {
    const { service } = build();
    const out = await service.record('t1', 'e1', input);

    expect(out.email).toBe('priya@example.com');
    expect(out.userId).toBe('u1');
    expect(out.ip).toBe('203.0.113.9');
    expect(Date.parse(out.acceptedAt)).not.toBeNaN();
  });

  it('hashes the document bytes it was shown', async () => {
    const { service } = build();
    const out = await service.record('t1', 'e1', {
      ...input,
      documentBytes: Buffer.from('the exact agreement text'),
    });
    expect(out.documentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a hash the caller computed itself', async () => {
    const sha = 'a'.repeat(64);
    const { service } = build();
    const out = await service.record('t1', 'e1', { ...input, documentSha256: sha });
    expect(out.documentSha256).toBe(sha);
  });

  it('records null rather than a fake hash when it has neither', async () => {
    // An acceptance with no anchor still has value — it just must not pretend to
    // one, or the wording can change afterwards undetected.
    const { service } = build();
    const out = await service.record('t1', 'e1', input);
    expect(out.documentSha256).toBeNull();
  });

  it('appends, so revised terms do not erase what was agreed first', async () => {
    // The earlier acceptance governs the period before the change.
    const entity = { id: 'e1', tenantId: 't1', verticalAttributes: {} };
    const { service, entities } = build(entity);

    await service.record('t1', 'e1', { ...input, subject: 'terms_v1' });
    entities.findOne.mockResolvedValue(entity);
    await service.record('t1', 'e1', { ...input, subject: 'terms_v2' });

    const list = entity.verticalAttributes as Record<string, any>;
    expect(list.acceptances).toHaveLength(2);
    expect(list.acceptances[0].subject).toBe('terms_v1');
  });

  it('does not disturb other vertical attributes', async () => {
    const entity = {
      id: 'e1',
      tenantId: 't1',
      verticalAttributes: { matter: { subclass: '482' } },
    };
    const { service } = build(entity);
    await service.record('t1', 'e1', input);
    expect((entity.verticalAttributes as any).matter.subclass).toBe('482');
  });

  it('writes an audit entry, which is what makes the record evidence', async () => {
    // A jsonb row can be edited by anyone with write access; the hash-chained
    // audit entry cannot be altered without breaking the chain.
    const { service, audit } = build();
    await service.record('t1', 'e1', input);

    const entry = audit.logEvent.mock.calls[0][0];
    expect(entry.entityType).toBe('entity_acceptance');
    expect(entry.userEmail).toBe('priya@example.com');
    expect(entry.afterState.isSignature).toBe(false);
    expect(entry.context.ip).toBe('203.0.113.9');
  });

  it('refuses an acceptance of nothing in particular', async () => {
    const { service } = build();
    await expect(
      service.record('t1', 'e1', { ...input, subject: '   ' }),
    ).rejects.toThrow(/subject is required/);
  });

  it("404s on a record that is not this tenant's", async () => {
    const { service } = build(null);
    await expect(service.record('t1', 'e1', input)).rejects.toThrow(/not found/i);
  });

  it('lists nothing rather than throwing when there are no acceptances', async () => {
    const { service } = build();
    await expect(service.list('t1', 'e1')).resolves.toEqual([]);
  });
});
