import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Notification,
  NotificationCategory,
  NotificationDirection,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from './entities/notification.entity';

export interface ThreadSummary {
  threadKey: string;
  channel: NotificationType;
  counterparty: string;
  messageCount: number;
  unreadCount: number;
  lastMessageAt: Date;
  lastSubject: string;
  lastPreview: string;
  lastDirection: NotificationDirection;
}

export interface ThreadMessage {
  id: string;
  direction: NotificationDirection;
  channel: NotificationType;
  subject: string;
  content: string;
  status: NotificationStatus;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface SendIntoThreadInput {
  tenantId: string;
  /** Who is sending. Recorded so the audit trail names a human. */
  senderId: string;
  channel: NotificationType;
  /** Email address or phone number of the counterparty. */
  to: string;
  subject: string;
  content: string;
  /** Set when replying; derived from `channel` + `to` when starting. */
  threadKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Conversations, out of a table that only ever recorded deliveries.
 *
 * The gap the frontend has been reporting for two cycles: COM is a one-way log
 * with no key to group on, so an inbox cannot be built, and the two ImmiStack
 * inboxes are stubbed. The compliance consequence is the point — staff use
 * their own mail client, and the firm's record of what it told a client is
 * whatever is in somebody's Outlook.
 *
 * A thread is `channel:counterparty`. Deliberately not `channel:entityId`:
 * a person emails from one address about three cases, and threading by case
 * would split one conversation three ways and lose the reply that arrives with
 * no case reference at all. The case linkage stays in `metadata`, where a UI
 * can surface it per message.
 */
@Injectable()
export class ThreadService {
  private readonly logger = new Logger(ThreadService.name);

  /** Characters of body text kept as the list preview. */
  private static readonly PREVIEW_CHARS = 160;

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  /**
   * `channel:counterparty`, lower-cased.
   *
   * Case-folded because `Jane@firm.com` and `jane@firm.com` are one person, and
   * two threads for one person is exactly the failure this key exists to
   * prevent. Must stay identical to the backfill in
   * `1755800000000-AddNotificationThreads` — if the two drift, history and new
   * messages land in different threads and the split is invisible.
   */
  deriveKey(channel: NotificationType, counterparty: string): string {
    return `${channel}:${counterparty.trim().toLowerCase()}`;
  }

  /**
   * Every thread in the tenant, most recently active first.
   *
   * Grouped in SQL rather than by loading rows: a firm with three years of
   * correspondence has hundreds of thousands of notifications, and an inbox
   * that pages through all of them to draw a list is the kind of endpoint that
   * works in demo and times out in production.
   */
  async listThreads(
    tenantId: string,
    options: { channel?: NotificationType; limit?: number; page?: number } = {},
  ): Promise<{ items: ThreadSummary[]; total: number; page: number; limit: number }> {
    const limit = Math.min(options.limit ?? 25, 100);
    const page = Math.max(options.page ?? 1, 1);

    const params: unknown[] = [tenantId];
    let channelFilter = '';
    if (options.channel) {
      params.push(options.channel);
      channelFilter = `AND n."type" = $${params.length}`;
    }

    const countRows = await this.notifications.query(
      `SELECT COUNT(DISTINCT n."threadKey")::int AS count
         FROM notifications n
        WHERE n."tenantId" = $1 AND n."threadKey" IS NOT NULL ${channelFilter}`,
      params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await this.notifications.query(
      `WITH ranked AS (
         SELECT n.*,
                ROW_NUMBER() OVER (
                  PARTITION BY n."threadKey" ORDER BY n."createdAt" DESC
                ) AS rn,
                COUNT(*)      OVER (PARTITION BY n."threadKey") AS message_count,
                COUNT(*) FILTER (WHERE n."readAt" IS NULL AND n."direction" = 'inbound')
                              OVER (PARTITION BY n."threadKey") AS unread_count
           FROM notifications n
          WHERE n."tenantId" = $1 AND n."threadKey" IS NOT NULL ${channelFilter}
       )
       SELECT "threadKey", "type", "recipientEmail", "recipientPhone", "recipientId",
              "subject", "content", "createdAt", "direction",
              message_count, unread_count
         FROM ranked
        WHERE rn = 1
        ORDER BY "createdAt" DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );

    const items: ThreadSummary[] = rows.map((r: Record<string, any>) => ({
      threadKey: r.threadKey,
      channel: r.type,
      // The counterparty is in the key's tail, which survives even when the
      // latest row's address columns are null (a template send that only
      // carried a recipientId).
      counterparty: String(r.threadKey).split(':').slice(1).join(':'),
      messageCount: Number(r.message_count),
      unreadCount: Number(r.unread_count),
      lastMessageAt: r.createdAt,
      lastSubject: r.subject,
      lastPreview: this.preview(r.content),
      lastDirection: r.direction,
    }));

    return { items, total, page, limit };
  }

  /** One conversation, oldest first — the order a person reads it in. */
  async getThread(
    tenantId: string,
    threadKey: string,
    options: { limit?: number; page?: number } = {},
  ): Promise<{
    threadKey: string;
    counterparty: string;
    messages: ThreadMessage[];
    total: number;
    page: number;
    limit: number;
  }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const page = Math.max(options.page ?? 1, 1);

    const [rows, total] = await this.notifications.findAndCount({
      where: { tenantId, threadKey },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      threadKey,
      counterparty: threadKey.split(':').slice(1).join(':'),
      messages: rows.map((n) => ({
        id: n.id,
        direction: n.direction,
        channel: n.type,
        subject: n.subject,
        content: n.content,
        status: n.status,
        sentAt: n.sentAt ?? null,
        readAt: n.readAt ?? null,
        createdAt: n.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Send a message from the UI into a thread.
   *
   * Without this the inbox is read-only, staff keep using their own mail
   * client, and nothing is recorded — which is the compliance gap, not a
   * convenience gap.
   *
   * The row is written as `PENDING` and left for `NotificationDispatchService`
   * to deliver, so a UI send takes exactly the same path, retries and failure
   * accounting as every other message. It also means a send is *recorded* even
   * with no transport configured, rather than being lost: the row shows as
   * pending, which is the truth.
   */
  async send(input: SendIntoThreadInput): Promise<Notification> {
    const to = input.to?.trim();
    if (!to) {
      throw new BadRequestException(
        'A recipient address is required — `to` is the counterparty email or phone number',
      );
    }

    const threadKey = input.threadKey ?? this.deriveKey(input.channel, to);

    // A caller-supplied threadKey that disagrees with the address would put the
    // message in a thread the reply can never join. Refuse rather than write a
    // row that looks filed and is not.
    const expected = this.deriveKey(input.channel, to);
    if (input.threadKey && input.threadKey !== expected) {
      throw new BadRequestException(
        `threadKey '${input.threadKey}' does not match channel '${input.channel}' ` +
          `and recipient '${to}' (expected '${expected}'). Omit threadKey to derive it.`,
      );
    }

    const isEmail = input.channel === NotificationType.EMAIL;

    const notification = this.notifications.create({
      tenantId: input.tenantId,
      type: input.channel,
      status: NotificationStatus.PENDING,
      priority: NotificationPriority.NORMAL,
      category: NotificationCategory.COLLABORATION,
      direction: NotificationDirection.OUTBOUND,
      threadKey,
      // No platform user sits behind a client's email address, so the
      // recipient columns carry the address and `recipientId` records who the
      // message is *about* only when a caller knows.
      recipientId: (input.metadata?.recipientId as string) ?? to,
      recipientEmail: isEmail ? to : (null as unknown as string),
      recipientPhone: isEmail ? (null as unknown as string) : to,
      subject: input.subject,
      content: input.content,
      // `metadata` is a typed bag on the entity; anything a caller passes that
      // is not one of its named fields belongs under `customData`.
      metadata: {
        ...(input.metadata ?? {}),
        customData: {
          ...((input.metadata?.customData as Record<string, unknown>) ?? {}),
          sentByUserId: input.senderId,
        },
      } as Notification['metadata'],
      templateData: {},
      deliveryAttempts: [],
      retryCount: 0,
    });

    const saved = await this.notifications.save(notification);
    this.logger.log(
      `Thread message queued: ${saved.id} → ${threadKey} by ${input.senderId}`,
    );
    return saved;
  }

  /** Mark every inbound message in a thread read. */
  async markRead(tenantId: string, threadKey: string): Promise<{ updated: number }> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date(), status: NotificationStatus.READ })
      .where('"tenantId" = :tenantId', { tenantId })
      .andWhere('"threadKey" = :threadKey', { threadKey })
      .andWhere('"readAt" IS NULL')
      .andWhere('"direction" = :direction', {
        direction: NotificationDirection.INBOUND,
      })
      .execute();

    return { updated: result.affected ?? 0 };
  }

  private preview(content: string | null): string {
    if (!content) return '';
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length > ThreadService.PREVIEW_CHARS
      ? `${flat.slice(0, ThreadService.PREVIEW_CHARS)}…`
      : flat;
  }
}
