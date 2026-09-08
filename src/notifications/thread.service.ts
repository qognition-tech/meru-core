import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
  /**
   * Email address or phone number of the counterparty. Required for staff;
   * ignored when `asCounterparty` is set.
   */
  to?: string;
  subject: string;
  content: string;
  /** Set when replying; derived from `channel` + `to` when starting. */
  threadKey?: string;
  metadata?: Record<string, unknown>;
  /**
   * The caller's own address when the caller is a client rather than staff.
   *
   * When set, this *is* the counterparty: `to` and `threadKey` are ignored and
   * the message is recorded as INBOUND. A client writing to the firm cannot be
   * threaded on the firm's address — every client would land in one shared
   * thread and read each other's mail, which is the same leak as listing
   * threads unscoped. Keyed on the client's own address instead, so their
   * message joins the thread staff already correspond with them on.
   */
  asCounterparty?: string | null;
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
   * The counterparty half of a thread key — everything after the first colon.
   *
   * Kept as one function because three places need to agree on it: the list
   * filter, the access check, and the summary mapping. `slice(1).join(':')`
   * rather than `split(':')[1]` because a phone number or an address with a
   * colon in it must not be truncated into a different counterparty.
   */
  counterpartyOf(threadKey: string): string {
    return threadKey.split(':').slice(1).join(':');
  }

  /**
   * Refuse a thread that does not belong to the caller.
   *
   * 404 rather than 403, matching `/payments/:id` — a 403 on someone else's
   * thread key confirms that the thread exists, which for `email:<address>`
   * keys tells the caller who else the firm is corresponding with. The key is
   * the counterparty, so the error would leak the very thing being protected.
   */
  private assertCounterparty(threadKey: string, counterparty: string | null): void {
    if (!counterparty) return;
    if (this.counterpartyOf(threadKey).toLowerCase() !== counterparty.toLowerCase()) {
      throw new NotFoundException('Thread not found');
    }
  }

  /**
   * Every thread in the tenant, most recently active first.
   *
   * Grouped in SQL rather than by loading rows: a firm with three years of
   * correspondence has hundreds of thousands of notifications, and an inbox
   * that pages through all of them to draw a list is the kind of endpoint that
   * works in demo and times out in production.
   *
   * `counterparty` restricts the list to one correspondent and is how a
   * client-role caller is confined to their own mail. RLS isolates tenants, not
   * users within a tenant, so without it a client token listed the firm's
   * entire inbox — every other applicant's address in the thread keys, and
   * their message bodies one request later. Third instance of this bug shape
   * after CRM and payments; enforced here in the service rather than the
   * controller so no future caller can forget it.
   */
  async listThreads(
    tenantId: string,
    options: {
      channel?: NotificationType;
      limit?: number;
      page?: number;
      counterparty?: string | null;
    } = {},
  ): Promise<{ items: ThreadSummary[]; total: number; page: number; limit: number }> {
    const limit = Math.min(options.limit ?? 25, 100);
    const page = Math.max(options.page ?? 1, 1);

    const params: unknown[] = [tenantId];
    let rowFilters = '';
    if (options.channel) {
      params.push(options.channel);
      rowFilters = `AND n."type" = $${params.length}`;
    }

    if (options.counterparty) {
      params.push(options.counterparty.trim().toLowerCase());
      // Mirrors `counterpartyOf` in SQL. Thread keys are already case-folded by
      // `deriveKey`, but lower() costs nothing and protects against rows written
      // before that was true.
      rowFilters +=
        ` AND lower(substring(n."threadKey" from position(':' in n."threadKey") + 1))` +
        ` = $${params.length}`;
    }

    const countRows = await this.notifications.query(
      `SELECT COUNT(DISTINCT n."threadKey")::int AS count
         FROM notifications n
        WHERE n."tenantId" = $1 AND n."threadKey" IS NOT NULL ${rowFilters}`,
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
          WHERE n."tenantId" = $1 AND n."threadKey" IS NOT NULL ${rowFilters}
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
      counterparty: this.counterpartyOf(String(r.threadKey)),
      messageCount: Number(r.message_count),
      unreadCount: Number(r.unread_count),
      lastMessageAt: r.createdAt,
      lastSubject: r.subject,
      lastPreview: this.preview(r.content),
      lastDirection: r.direction,
    }));

    return { items, total, page, limit };
  }

  /**
   * One conversation, oldest first — the order a person reads it in.
   *
   * `counterparty` is the client-role confinement; see `listThreads`. Checked
   * before the query so another applicant's thread is indistinguishable from a
   * thread that was never there.
   */
  async getThread(
    tenantId: string,
    threadKey: string,
    options: { limit?: number; page?: number; counterparty?: string | null } = {},
  ): Promise<{
    threadKey: string;
    counterparty: string;
    messages: ThreadMessage[];
    total: number;
    page: number;
    limit: number;
  }> {
    this.assertCounterparty(threadKey, options.counterparty ?? null);

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
      counterparty: this.counterpartyOf(threadKey),
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
    // A client speaks only as themselves. Their address replaces whatever `to`
    // and `threadKey` say, so they can neither open a thread against another
    // applicant nor drop a message into one.
    const inbound = !!input.asCounterparty;
    const to = inbound ? input.asCounterparty!.trim() : input.to?.trim();
    if (!to) {
      throw new BadRequestException(
        'A recipient address is required — `to` is the counterparty email or phone number',
      );
    }

    const expected = this.deriveKey(input.channel, to);
    const threadKey = inbound ? expected : (input.threadKey ?? expected);

    // A caller-supplied threadKey that disagrees with the address would put the
    // message in a thread the reply can never join. Refuse rather than write a
    // row that looks filed and is not.
    if (!inbound && input.threadKey && input.threadKey !== expected) {
      throw new BadRequestException(
        `threadKey '${input.threadKey}' does not match channel '${input.channel}' ` +
          `and recipient '${to}' (expected '${expected}'). Omit threadKey to derive it.`,
      );
    }

    const isEmail = input.channel === NotificationType.EMAIL;

    const notification = this.notifications.create({
      tenantId: input.tenantId,
      type: input.channel,
      priority: NotificationPriority.NORMAL,
      category: NotificationCategory.COLLABORATION,
      // A client's message travels *into* the firm. Recorded as inbound so it
      // counts toward staff's unread badge and is never handed to a transport
      // for delivery back to the person who wrote it.
      direction: inbound
        ? NotificationDirection.INBOUND
        : NotificationDirection.OUTBOUND,
      status: inbound ? NotificationStatus.DELIVERED : NotificationStatus.PENDING,
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
  async markRead(
    tenantId: string,
    threadKey: string,
    counterparty: string | null = null,
  ): Promise<{ updated: number }> {
    this.assertCounterparty(threadKey, counterparty);

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
