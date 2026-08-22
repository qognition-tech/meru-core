import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  InboundWebhookEndpoint,
  WebhookSignatureScheme,
} from './entities/inbound-webhook-endpoint.entity';
import { InboundWebhookEvent } from './entities/inbound-webhook-event.entity';
import { TenantContext } from '../core/tenancy/tenant-context';
import { CreateInboundEndpointDto } from './dto/create-endpoint.dto';

/** Emitted after an event with a valid (or unverifiable-by-design) signature is stored. */
export const INBOUND_WEBHOOK_RECEIVED = 'webhook.inbound.received';

export interface InboundWebhookReceivedPayload {
  tenantId: string;
  endpointId: string;
  provider: string | null;
  eventId: string;
  eventType: string | null;
  /** null when the endpoint is scheme `none` — do not act on it as if verified. */
  signatureValid: boolean | null;
  body: Record<string, unknown>;
}

/** Headers worth keeping on the event row. Never Authorization, cookies, or the signature itself. */
const KEPT_HEADERS = [
  'content-type',
  'user-agent',
  'x-request-id',
  'x-delivery-id',
  'x-github-delivery',
  'x-cal-delivery-id',
  'idempotency-key',
];

@Injectable()
export class InboundWebhookService {
  private readonly logger = new Logger(InboundWebhookService.name);

  constructor(
    @InjectRepository(InboundWebhookEndpoint)
    private readonly endpointRepo: Repository<InboundWebhookEndpoint>,
    @InjectRepository(InboundWebhookEvent)
    private readonly eventRepo: Repository<InboundWebhookEvent>,
    private readonly events: EventEmitter2,
  ) {}

  // ── Endpoint management (tenant-bound, authenticated) ────────────────────

  async create(
    tenantId: string,
    dto: CreateInboundEndpointDto,
  ): Promise<{ endpoint: Omit<InboundWebhookEndpoint, 'secret'>; secret: string }> {
    const scheme: WebhookSignatureScheme = dto.signatureScheme ?? 'hmac-sha256-hex';
    const secret =
      dto.secret ?? (scheme === 'none' ? '' : randomBytes(32).toString('hex'));
    const saved = await this.endpointRepo.save(
      this.endpointRepo.create({
        tenantId,
        name: dto.name,
        provider: dto.provider ?? null,
        signatureScheme: scheme,
        signatureHeader:
          dto.signatureHeader?.toLowerCase() ??
          (scheme === 'bearer-token' ? 'authorization' : 'x-meru-signature'),
        secret,
        eventTypePath: dto.eventTypePath ?? null,
        active: true,
      }),
    );
    const { secret: _omit, ...rest } = saved;
    return { endpoint: rest, secret };
  }

  async list(tenantId: string): Promise<Array<Omit<InboundWebhookEndpoint, 'secret'>>> {
    const rows = await this.endpointRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(({ secret: _omit, ...rest }) => rest);
  }

  async setActive(tenantId: string, id: string, active: boolean) {
    const row = await this.endpointRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException(`Endpoint ${id} not found`);
    row.active = active;
    const { secret: _omit, ...rest } = await this.endpointRepo.save(row);
    return rest;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.endpointRepo.delete({ id, tenantId });
    if (!result.affected) throw new NotFoundException(`Endpoint ${id} not found`);
  }

  async listEvents(
    tenantId: string,
    endpointId?: string,
    limit = 100,
  ): Promise<InboundWebhookEvent[]> {
    const where: Record<string, unknown> = { tenantId };
    if (endpointId) where.endpointId = endpointId;
    return this.eventRepo.find({
      where,
      order: { receivedAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  // ── Receiving (public route) ─────────────────────────────────────────────

  /**
   * Verify, record, acknowledge. Returns the stored event id.
   *
   * Lookup runs as system because the caller is anonymous and the endpoint id
   * is the only thing identifying the tenant; the write is then bound to that
   * tenant so RLS scopes it like any other row. An unknown or inactive
   * endpoint is a 404 with no detail — the id is effectively a capability and
   * an enumerator learns nothing.
   */
  async receive(input: {
    endpointId: string;
    rawBody: Buffer | undefined;
    headers: Record<string, string | string[] | undefined>;
    sourceIp: string | null;
  }): Promise<{ eventId: string }> {
    const endpoint = await TenantContext.runAsSystem(
      'inbound webhook: resolve endpoint to tenant',
      () => this.endpointRepo.findOne({ where: { id: input.endpointId } }),
    );
    if (!endpoint || !endpoint.active) {
      throw new NotFoundException('No such endpoint');
    }

    const raw = input.rawBody ?? Buffer.alloc(0);
    const signatureValid = this.verify(endpoint, raw, input.headers);

    const body = InboundWebhookService.parseBody(raw);
    const eventType = endpoint.eventTypePath
      ? InboundWebhookService.pluck(body, endpoint.eventTypePath)
      : null;

    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = input.headers[name];
      if (typeof v === 'string') headers[name] = v.slice(0, 500);
    }

    // Bind the tenant for the write. The ALS store exists (middleware ran);
    // it just has no tenant because there was no JWT.
    if (!TenantContext.setTenantId(endpoint.tenantId)) {
      throw new Error('Inbound webhook received outside a tenant context');
    }

    const event = await this.eventRepo.save(
      this.eventRepo.create({
        tenantId: endpoint.tenantId,
        endpointId: endpoint.id,
        receivedAt: new Date(),
        status: signatureValid === false ? 'rejected' : 'received',
        signatureValid,
        eventType: eventType ? String(eventType).slice(0, 120) : null,
        body,
        headers,
        sourceIp: input.sourceIp,
      }),
    );
    endpoint.lastReceivedAt = event.receivedAt;
    await this.endpointRepo.save(endpoint);

    if (signatureValid === false) {
      this.logger.warn(
        `Inbound webhook ${endpoint.id} (${endpoint.provider ?? 'unspecified'}) rejected: bad signature; stored as ${event.id}`,
      );
      throw new UnauthorizedException({
        code: 'MER-AUTH-0401',
        message: 'Webhook signature did not verify',
        eventId: event.id,
      });
    }

    const payload: InboundWebhookReceivedPayload = {
      tenantId: endpoint.tenantId,
      endpointId: endpoint.id,
      provider: endpoint.provider,
      eventId: event.id,
      eventType: event.eventType,
      signatureValid,
      body,
    };
    this.events.emit(INBOUND_WEBHOOK_RECEIVED, payload);
    return { eventId: event.id };
  }

  /** true / false, or null for scheme `none` (unverified — not "verified"). */
  private verify(
    endpoint: InboundWebhookEndpoint,
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | null {
    if (endpoint.signatureScheme === 'none') return null;
    const headerName = (endpoint.signatureHeader ?? 'x-meru-signature').toLowerCase();
    const presented = headers[headerName];
    const value = Array.isArray(presented) ? presented[0] : presented;
    if (!value) return false;

    if (endpoint.signatureScheme === 'bearer-token') {
      const token = value.replace(/^Bearer\s+/i, '').trim();
      return InboundWebhookService.safeEqual(token, endpoint.secret);
    }

    const digest = createHmac('sha256', endpoint.secret).update(raw).digest();
    const expected =
      endpoint.signatureScheme === 'hmac-sha256-base64'
        ? digest.toString('base64')
        : digest.toString('hex');
    // Accept `sha256=<sig>`, `t=…,v1=<sig>` (Stripe-style), or the bare value.
    const candidates = value
      .split(',')
      .map((part) => part.trim().replace(/^(sha256|v1|sha256sig)=/i, ''))
      .filter(Boolean);
    return candidates.some((c) => InboundWebhookService.safeEqual(c, expected));
  }

  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  static parseBody(raw: Buffer): Record<string, unknown> {
    if (!raw.length) return {};
    const text = raw.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: text.slice(0, 100_000) };
    }
  }

  static pluck(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  }
}
