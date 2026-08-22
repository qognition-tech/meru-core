import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * How an inbound request proves it came from the sender.
 *
 * - `hmac-sha256-hex`    — `<header>: [sha256=]<hex hmac of raw body>`
 *                          (GitHub, Cal.com, Dropbox Sign, most of the field)
 * - `hmac-sha256-base64` — same, base64 (Twilio-style, Meta with a secret)
 * - `bearer-token`       — `Authorization: Bearer <secret>` or `<header>: <secret>`
 *                          for senders that cannot sign
 * - `none`               — recorded but flagged `signatureValid: null`.
 *                          Allowed so a provider can be wired before its
 *                          secret is known; nothing downstream may trust an
 *                          event from such an endpoint.
 */
export type WebhookSignatureScheme =
  | 'hmac-sha256-hex'
  | 'hmac-sha256-base64'
  | 'bearer-token'
  | 'none';

@Entity('inbound_webhook_endpoints')
@Index(['tenantId'])
export class InboundWebhookEndpoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Free-text hint: `calcom`, `dropbox-sign`, `whatsapp`, … Not interpreted. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', length: 30, default: 'hmac-sha256-hex' })
  signatureScheme: WebhookSignatureScheme;

  /** Header carrying the signature/token. Default depends on scheme. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  signatureHeader: string | null;

  /**
   * The shared secret. Returned exactly once, on creation. Stored as-is
   * because HMAC verification needs the bytes — a hash would only support the
   * bearer scheme. Tenant-scoped by RLS like everything else here.
   */
  @Column({ type: 'text' })
  secret: string;

  /** Optional JSON path (dot notation) to the event's type, e.g. `event`, `type`, `payload.event_type`. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  eventTypePath: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastReceivedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
