import { createHmac } from 'crypto';
import { InboundWebhookService } from './inbound-webhook.service';
import { InboundWebhookEndpoint } from './entities/inbound-webhook-endpoint.entity';

const endpoint = (over: Partial<InboundWebhookEndpoint>): InboundWebhookEndpoint =>
  ({
    id: 'e1',
    tenantId: 't1',
    name: 'x',
    provider: null,
    signatureScheme: 'hmac-sha256-hex',
    signatureHeader: 'x-meru-signature',
    secret: 'topsecret-topsecret',
    eventTypePath: null,
    active: true,
    lastReceivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as InboundWebhookEndpoint;

describe('InboundWebhookService.verify', () => {
  const svc = new InboundWebhookService(
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const verify = (ep: InboundWebhookEndpoint, raw: string, headers: Record<string, string>) =>
    (svc as unknown as { verify: (...a: unknown[]) => boolean | null }).verify(
      ep,
      Buffer.from(raw),
      headers,
    );
  const raw = '{"event":"BOOKING_CREATED","x":1}';
  const hex = createHmac('sha256', 'topsecret-topsecret').update(raw).digest('hex');
  const b64 = createHmac('sha256', 'topsecret-topsecret').update(raw).digest('base64');

  it('accepts a bare hex HMAC, a sha256= prefix, and a v1= list', () => {
    expect(verify(endpoint({}), raw, { 'x-meru-signature': hex })).toBe(true);
    expect(verify(endpoint({}), raw, { 'x-meru-signature': `sha256=${hex}` })).toBe(true);
    expect(verify(endpoint({}), raw, { 'x-meru-signature': `t=1,v1=${hex}` })).toBe(true);
  });

  it('rejects a wrong or missing signature, and a signature over different bytes', () => {
    expect(verify(endpoint({}), raw, { 'x-meru-signature': 'deadbeef' })).toBe(false);
    expect(verify(endpoint({}), raw, {})).toBe(false);
    expect(verify(endpoint({}), raw + ' ', { 'x-meru-signature': hex })).toBe(false);
  });

  it('honours the configured header and base64 scheme', () => {
    const ep = endpoint({ signatureScheme: 'hmac-sha256-base64', signatureHeader: 'x-hub-sig' });
    expect(verify(ep, raw, { 'x-hub-sig': b64 })).toBe(true);
    expect(verify(ep, raw, { 'x-meru-signature': b64 })).toBe(false);
  });

  it('bearer-token compares the secret, with or without the Bearer prefix', () => {
    const ep = endpoint({ signatureScheme: 'bearer-token', signatureHeader: 'authorization' });
    expect(verify(ep, raw, { authorization: 'Bearer topsecret-topsecret' })).toBe(true);
    expect(verify(ep, raw, { authorization: 'topsecret-topsecret' })).toBe(true);
    expect(verify(ep, raw, { authorization: 'Bearer nope' })).toBe(false);
  });

  it('scheme none is null — unverified, never true', () => {
    expect(verify(endpoint({ signatureScheme: 'none', secret: '' }), raw, {})).toBeNull();
  });
});

describe('InboundWebhookService body helpers', () => {
  it('parses JSON objects, wraps non-objects, and keeps unparseable text as raw', () => {
    expect(InboundWebhookService.parseBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    expect(InboundWebhookService.parseBody(Buffer.from('[1]'))).toEqual({ value: [1] });
    expect(InboundWebhookService.parseBody(Buffer.from('a=b'))).toEqual({ raw: 'a=b' });
    expect(InboundWebhookService.parseBody(Buffer.alloc(0))).toEqual({});
  });
  it('plucks a dotted path', () => {
    expect(InboundWebhookService.pluck({ a: { b: 'c' } }, 'a.b')).toBe('c');
    expect(InboundWebhookService.pluck({ a: 1 }, 'a.b')).toBeUndefined();
  });
});
