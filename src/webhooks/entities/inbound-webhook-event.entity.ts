import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type InboundWebhookEventStatus = 'received' | 'rejected';

/**
 * One delivery to an inbound endpoint, as received. The receiver records and
 * acknowledges; it does not interpret. A consumer (a signature-provider
 * adapter, a booking sync) listens for `webhook.inbound.received` and reads
 * `body` itself.
 *
 * A delivery whose signature failed is still stored — `status: rejected`,
 * `signatureValid: false` — because a burst of them is the thing an operator
 * needs to see. It is acknowledged with 401 so the sender retries once the
 * secret is fixed.
 */
@Entity('inbound_webhook_events')
@Index(['tenantId', 'endpointId', 'receivedAt'])
export class InboundWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  endpointId: string;

  @Column({ type: 'timestamptz' })
  receivedAt: Date;

  @Column({ type: 'varchar', length: 20 })
  status: InboundWebhookEventStatus;

  /** null when the endpoint's scheme is `none` — unverified, not verified. */
  @Column({ type: 'boolean', nullable: true })
  signatureValid: boolean | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  eventType: string | null;

  /** Parsed JSON body when it parsed; otherwise `{ raw: "<text>" }`. */
  @Column({ type: 'jsonb' })
  body: Record<string, unknown>;

  /** A whitelist of headers worth keeping; never Authorization or cookies. */
  @Column({ type: 'jsonb', default: {} })
  headers: Record<string, string>;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceIp: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
