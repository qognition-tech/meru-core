import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
  NotificationType,
} from './entities/notification.entity';
import { User } from '../iam/entities/user.entity';
import { MailService } from '../core/mail/mail.service';
import { TenantContext } from '../core/tenancy/tenant-context';

/**
 * Actually delivers notifications. NotificationsService writes rows and emits
 * an event nobody consumed, so every notification sat at `pending` forever —
 * the COM module has been storage-only since it was written.
 *
 * Drained from `/jobs/tick` rather than a @Cron: @nestjs/schedule never fires
 * on Vercel, so an in-process timer would be dead in production.
 *
 * Email is live via Resend. SMS/WhatsApp are declared here and deliberately
 * left as explicit "no transport" failures rather than silent successes —
 * a channel that reports `sent` without a provider is worse than one that
 * reports why it couldn't.
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly mailService: MailService,
  ) {}

  /**
   * Deliver a batch of pending notifications across all tenants. Runs as
   * system: the dispatcher is platform infrastructure with no request tenant,
   * and each notification carries its own tenantId.
   */
  async dispatchPending(limit = 50): Promise<{
    processed: number;
    delivered: number;
    failed: number;
    skipped: number;
  }> {
    return TenantContext.runAsSystem('notification dispatch sweep', async () => {
      const due = await this.notificationRepo.find({
        where: [
          // Unscheduled pending rows, plus scheduled ones whose time has come.
          { status: NotificationStatus.PENDING, scheduledAt: IsNull() },
          {
            status: NotificationStatus.PENDING,
            scheduledAt: LessThanOrEqual(new Date()),
          },
          { status: NotificationStatus.QUEUED },
        ],
        order: { createdAt: 'ASC' },
        take: limit,
      });

      let delivered = 0;
      let failed = 0;
      let skipped = 0;

      for (const notification of due) {
        // IN_APP needs no transport — the row IS the delivery.
        if (notification.type === NotificationType.IN_APP) {
          notification.status = NotificationStatus.DELIVERED;
          notification.sentAt = new Date();
          await this.notificationRepo.save(notification);
          skipped += 1;
          continue;
        }

        if (notification.type === NotificationType.WEBHOOK) {
          const sent = await this.dispatchWebhook(notification);
          if (sent) {
            notification.status = NotificationStatus.SENT;
            notification.sentAt = new Date();
            delivered += 1;
          } else {
            notification.retryCount = (notification.retryCount ?? 0) + 1;
            notification.status =
              notification.retryCount >= 3
                ? NotificationStatus.FAILED
                : NotificationStatus.RETRYING;
            failed += 1;
          }
          await this.notificationRepo.save(notification);
          continue;
        }

        if (notification.type !== NotificationType.EMAIL) {
          this.recordAttempt(
            notification,
            false,
            `no transport configured for channel '${notification.type}'`,
          );
          notification.status = NotificationStatus.FAILED;
          await this.notificationRepo.save(notification);
          failed += 1;
          continue;
        }

        const address = await this.resolveEmail(notification);
        if (!address) {
          this.recordAttempt(notification, false, 'recipient has no email address');
          notification.status = NotificationStatus.FAILED;
          await this.notificationRepo.save(notification);
          failed += 1;
          continue;
        }

        // Persist what the address turned out to be, and re-key the thread if
        // the row was created before anyone knew it. A message keyed by user id
        // and its reply keyed by address are the same conversation, and leaving
        // them in two threads is invisible until a client asks where the rest
        // of their correspondence went.
        notification.recipientEmail = address;
        const addressKey = `${notification.type}:${address.trim().toLowerCase()}`;
        if (notification.threadKey !== addressKey) {
          notification.threadKey = addressKey;
        }

        const result = await this.mailService.send({
          to: address,
          subject: notification.subject || 'Notification',
          text: notification.content ?? '',
        });

        if (result.delivered) {
          notification.status = NotificationStatus.SENT;
          notification.sentAt = new Date();
          this.recordAttempt(notification, true);
          delivered += 1;
        } else {
          // Mail unconfigured or provider rejected: retry rather than lose it.
          notification.retryCount = (notification.retryCount ?? 0) + 1;
          notification.status =
            notification.retryCount >= 3
              ? NotificationStatus.FAILED
              : NotificationStatus.RETRYING;
          this.recordAttempt(notification, false, 'mail provider did not deliver');
          failed += 1;
        }
        await this.notificationRepo.save(notification);
      }

      if (due.length) {
        this.logger.log(
          `Notification dispatch: ${due.length} processed, ${delivered} delivered, ${failed} failed, ${skipped} in-app`,
        );
      }
      return { processed: due.length, delivered, failed, skipped };
    });
  }

  /**
   * POST a webhook notification to the URL it carries.
   *
   * `NotificationType.WEBHOOK` existed in the enum with no dispatcher, so every
   * webhook row sat pending forever — a channel the API advertised and never
   * delivered on.
   *
   * Signed with HMAC-SHA256 over the exact bytes sent, using the tenant's
   * `WEBHOOK_SIGNING_SECRET`. Unsigned webhooks are worse than none: the
   * receiver has no way to distinguish our call from anyone who learned the
   * URL, and the whole point of the channel is to trigger action in another
   * system. When no secret is configured the call still goes out and the
   * signature header is omitted, so the receiver can tell the difference
   * rather than trusting an empty string.
   */
  private async dispatchWebhook(notification: Notification): Promise<boolean> {
    const metadata = (notification.metadata ?? {}) as {
      url?: string;
      customData?: Record<string, unknown>;
    };
    const url = metadata.url ?? (metadata.customData?.url as string | undefined);

    if (!url) {
      this.recordAttempt(
        notification,
        false,
        'webhook notification carries no target url in metadata.url',
      );
      return false;
    }

    const payload = JSON.stringify({
      id: notification.id,
      tenantId: notification.tenantId,
      category: notification.category,
      subject: notification.subject,
      content: notification.content,
      data: notification.templateData ?? {},
      sentAt: new Date().toISOString(),
    });

    const secret = process.env.WEBHOOK_SIGNING_SECRET;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'meru-core-webhooks/1',
      'X-Meru-Notification-Id': notification.id,
    };
    if (secret) {
      headers['X-Meru-Signature'] = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        // A receiver that hangs must not hold the dispatch sweep open — the
        // rest of the tenant's notifications are behind it.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.recordAttempt(
          notification,
          false,
          `webhook returned HTTP ${response.status}`,
        );
        return false;
      }

      this.recordAttempt(notification, true);
      return true;
    } catch (err) {
      this.recordAttempt(
        notification,
        false,
        `webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async resolveEmail(
    notification: Notification,
  ): Promise<string | null> {
    const explicit = (
      notification.metadata as { email?: string } | null | undefined
    )?.email;
    if (explicit) return explicit;

    if (!notification.recipientId) return null;
    const user = await this.userRepo.findOne({
      where: { id: notification.recipientId },
      select: ['id', 'email'],
    });
    return user?.email ?? null;
  }

  private recordAttempt(
    notification: Notification,
    success: boolean,
    error?: string,
  ): void {
    const attempts = Array.isArray(notification.deliveryAttempts)
      ? notification.deliveryAttempts
      : [];
    attempts.push({
      timestamp: new Date().toISOString(),
      channel: notification.type,
      success,
      ...(error ? { error } : {}),
    } as never);
    notification.deliveryAttempts = attempts;
  }

  /** Retry rows parked in RETRYING; called from the same tick. */
  async retryFailed(limit = 25): Promise<{ requeued: number }> {
    return TenantContext.runAsSystem('notification retry sweep', async () => {
      const result = await this.notificationRepo.update(
        { status: In([NotificationStatus.RETRYING]) },
        { status: NotificationStatus.PENDING },
      );
      return { requeued: Math.min(result.affected ?? 0, limit) };
    });
  }
}
