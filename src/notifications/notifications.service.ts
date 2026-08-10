import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import {
  Notification,
  NotificationStatus,
  NotificationType,
  NotificationPriority,
  NotificationCategory,
  NotificationPreference,
  NotificationTemplate,
  TemplateType,
} from './entities/notification.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import type { PackMessageTemplate } from '../../packages/config-packs/_schema/pack.schema';

export interface SendNotificationOptions {
  tenantId: string;
  type: NotificationType;
  recipientId: string;
  subject: string;
  content: string;
  priority?: NotificationPriority;
  category?: NotificationCategory;
  metadata?: Record<string, any>;
  templateData?: {
    templateId?: string;
    /**
     * The pack template key. Recorded because a pack-sourced template has no
     * row and therefore no `templateId` — without the key there would be no way
     * to tell afterwards which template rendered a given message.
     */
    templateKey?: string;
    /** Which layer supplied the template, for the same reason. */
    source?: 'tenant_override' | 'config_pack';
    variables?: Record<string, any>;
    locale?: string;
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationPreference)
    private preferenceRepo: Repository<NotificationPreference>,
    @InjectRepository(NotificationTemplate)
    private templateRepo: Repository<NotificationTemplate>,
    private eventEmitter: EventEmitter2,
    private readonly packs: VerticalPackService,
  ) {}

  // ==================== NOTIFICATION CREATION ====================

  async sendNotification(
    options: SendNotificationOptions,
  ): Promise<Notification | null> {
    // Check user preferences
    const preferences = await this.getUserPreferences(
      options.tenantId,
      options.recipientId,
    );

    if (!this.shouldSendNotification(preferences, options)) {
      this.logger.debug(
        `Notification skipped due to preferences: ${options.recipientId}`,
      );
      return null;
    }

    // Check quiet hours
    if (this.isInQuietHours(preferences)) {
      // Queue for later delivery
      return this.scheduleNotification(
        options,
        this.getQuietHoursEnd(preferences),
      );
    }

    const notification = this.notificationRepo.create({
      tenantId: options.tenantId,
      type: options.type,
      status: NotificationStatus.PENDING,
      priority: options.priority || NotificationPriority.NORMAL,
      category: options.category || NotificationCategory.SYSTEM,
      recipientId: options.recipientId,
      subject: options.subject,
      content: options.content,
      metadata: options.metadata || {},
      templateData: options.templateData || {},
      deliveryAttempts: [],
      retryCount: 0,
    });

    const saved = await this.notificationRepo.save(notification);

    // Emit event for processing
    this.eventEmitter.emit('notification.created', saved);

    this.logger.log(
      `Notification created: ${saved.id} for user ${options.recipientId}`,
    );
    return saved;
  }

  async sendBulkNotifications(
    tenantId: string,
    notifications: SendNotificationOptions[],
  ): Promise<Notification[]> {
    const results: Notification[] = [];

    for (const options of notifications) {
      try {
        const notification = await this.sendNotification({
          ...options,
          tenantId,
        });
        if (notification) results.push(notification);
      } catch (error) {
        this.logger.error(`Failed to send notification:`, error);
      }
    }

    return results;
  }

  /**
   * Render a template and queue it.
   *
   * Two layers, tenant-first, for the same reason as the AI prompt library:
   * `notification_templates` is per-tenant and has to be seeded per tenant, and
   * on production it was empty — `GET /notifications/templates` returned `[]`,
   * so every template-driven message threw `Template not found` no matter
   * whether a mail transport was configured. The vertical's config pack now
   * supplies the defaults, so a tenant has working templates from the moment
   * its pack is pinned, and a DB row is an override rather than a prerequisite.
   *
   * `vertical` is optional so existing callers keep compiling; pass it when the
   * caller knows it, or the pack layer cannot be consulted and behaviour is the
   * old DB-only lookup.
   */
  async sendFromTemplate(
    tenantId: string,
    templateKey: string,
    recipientId: string,
    variables: Record<string, any>,
    vertical?: string | null,
    /**
     * For recipients who are not platform users.
     *
     * A messaging sequence addresses a *client* — a CRM entity with an email
     * address and no login — so `recipientId` is that entity's id and the
     * dispatcher cannot look the address up in `users`. Passing it here is
     * the difference between a chaser that sends and one that is silently
     * skipped as "recipient has no email address".
     */
    options?: {
      recipientEmail?: string | null;
      metadata?: Record<string, any>;
    },
  ): Promise<Notification | null> {
    const resolved = await this.resolveTemplate(
      tenantId,
      templateKey,
      vertical ?? null,
    );

    // Replace variables in template. Both layers render identically — the
    // substitution must not depend on where the template came from, or an
    // override silently changes how placeholders behave.
    let content = resolved.body;
    let subject = resolved.subject;

    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      content = content.replace(regex, String(value));
      subject = subject.replace(regex, String(value));
    });

    return this.sendNotification({
      tenantId,
      type: resolved.channel as unknown as NotificationType,
      recipientId,
      subject,
      content,
      metadata: {
        ...(options?.metadata ?? {}),
        // `resolveEmail` in the dispatcher reads `metadata.email` before it
        // tries the users table, which is the only route to a non-user
        // recipient.
        ...(options?.recipientEmail ? { email: options.recipientEmail } : {}),
      },
      templateData: {
        templateId: resolved.templateId,
        templateKey,
        source: resolved.source,
        variables,
      },
    });
  }

  /**
   * Tenant row → vertical pack. Throws only when neither has it, and says
   * which layers were checked: "Template not found" on its own sent whoever
   * hit it looking for a bug in the caller rather than for an unpopulated
   * table and an un-authored pack.
   */
  private async resolveTemplate(
    tenantId: string,
    templateKey: string,
    vertical: string | null,
  ): Promise<{
    subject: string;
    body: string;
    channel: string;
    templateId?: string;
    source: 'tenant_override' | 'config_pack';
  }> {
    const row = await this.templateRepo.findOne({
      where: { key: templateKey, tenantId },
    });

    if (row) {
      return {
        subject: row.subject,
        body: row.content,
        channel: String(row.type),
        templateId: row.id,
        source: 'tenant_override',
      };
    }

    const { pack, section } = await this.packs.sectionWithPack<{
      templates?: PackMessageTemplate[];
    }>(vertical, 'messaging');

    const templates = section?.templates ?? [];
    const match = templates.find((t) => t.key === templateKey);

    if (!match) {
      throw new NotFoundException(
        `No message template '${templateKey}' — not in this tenant's overrides` +
          (pack
            ? `, and config pack '${pack.code}' defines ${templates.length} template(s).`
            : ', and no config pack resolved for this vertical.'),
      );
    }

    return {
      subject: match.subject,
      body: match.body,
      channel: match.channel,
      source: 'config_pack',
    };
  }

  // ==================== NOTIFICATION QUERY ====================

  async getNotifications(
    tenantId: string,
    userId: string,
    options: {
      status?: NotificationStatus;
      type?: NotificationType;
      category?: NotificationCategory;
      isRead?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ notifications: Notification[]; total: number }> {
    const where: any = { tenantId, recipientId: userId };

    if (options.status) where.status = options.status;
    if (options.type) where.type = options.type;
    if (options.category) where.category = options.category;
    if (options.isRead !== undefined) {
      where.readAt = options.isRead ? MoreThan(new Date(0)) : null;
    }

    const [notifications, total] = await this.notificationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: ((options.page || 1) - 1) * (options.limit || 20),
      take: options.limit || 20,
    });

    return { notifications, total };
  }

  async getUnreadCount(tenantId: string, userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: {
        tenantId,
        recipientId: userId,
        readAt: undefined,
      },
    });
  }

  // ==================== NOTIFICATION ACTIONS ====================

  async markAsRead(notificationIds: string[], userId: string): Promise<void> {
    await this.notificationRepo.update(notificationIds, {
      status: NotificationStatus.READ,
      readAt: new Date(),
    });
  }

  async markAllAsRead(tenantId: string, userId: string): Promise<void> {
    await this.notificationRepo.update(
      { tenantId, recipientId: userId },
      {
        status: NotificationStatus.READ,
        readAt: new Date(),
      },
    );
  }

  async deleteNotification(id: string, userId: string): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id, recipientId: userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.notificationRepo.softDelete(id);
  }

  // ==================== PREFERENCES ====================

  async getUserPreferences(
    tenantId: string,
    userId: string,
  ): Promise<NotificationPreference> {
    let preferences = await this.preferenceRepo.findOne({
      where: { tenantId, userId },
    });

    if (!preferences) {
      // Create default preferences
      preferences = this.preferenceRepo.create({
        tenantId,
        userId,
        channels: {
          email: { enabled: true, address: '', verified: false },
          inApp: { enabled: true, soundEnabled: true, showPreview: true },
        },
        categoryPreferences: {
          system: {
            enabled: true,
            channels: [NotificationType.IN_APP, NotificationType.EMAIL],
          },
          workflow: {
            enabled: true,
            channels: [NotificationType.IN_APP, NotificationType.EMAIL],
          },
          task: { enabled: true, channels: [NotificationType.IN_APP] },
          billing: { enabled: true, channels: [NotificationType.EMAIL] },
          security: {
            enabled: true,
            channels: [NotificationType.EMAIL, NotificationType.IN_APP],
          },
        },
      });
      await this.preferenceRepo.save(preferences);
    }

    return preferences;
  }

  async updatePreferences(
    tenantId: string,
    userId: string,
    updates: Partial<NotificationPreference>,
  ): Promise<NotificationPreference> {
    const preferences = await this.getUserPreferences(tenantId, userId);
    Object.assign(preferences, updates);
    return this.preferenceRepo.save(preferences);
  }

  // ==================== TEMPLATES ====================

  async createTemplate(
    tenantId: string,
    data: Partial<NotificationTemplate>,
  ): Promise<NotificationTemplate> {
    const template = this.templateRepo.create({
      tenantId,
      ...data,
    });
    return this.templateRepo.save(template);
  }

  /**
   * Every template available to the tenant: its own rows, plus the vertical
   * pack's, with a tenant row of the same key shadowing the pack entry.
   *
   * Returning only DB rows is what made this endpoint report `[]` on a tenant
   * that could in fact render nine templates — and an empty list here reads to
   * a UI as "this tenant has no templates", which is a different and false
   * statement. `source` is on every row so an operator can see which layer a
   * template came from before editing the wrong one.
   */
  async getTemplates(
    tenantId: string,
    type?: string,
    vertical?: string | null,
  ): Promise<
    Array<{
      id: string | null;
      key: string;
      name: string;
      type: string;
      subject: string;
      content: string;
      variables: string[];
      source: 'tenant_override' | 'config_pack';
    }>
  > {
    const where: Record<string, unknown> = { tenantId };
    if (type) where.type = type;

    const rows = await this.templateRepo.find({ where });
    const overridden = new Set(rows.map((r) => r.key));

    const packSection = await this.packs.section<{
      templates?: PackMessageTemplate[];
    }>(vertical ?? null, 'messaging');

    const packTemplates = (packSection?.templates ?? [])
      .filter((t) => !overridden.has(t.key))
      .filter((t) => !type || t.channel === type);

    return [
      ...rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        type: String(r.type),
        subject: r.subject,
        content: r.content,
        variables: r.variables ?? [],
        source: 'tenant_override' as const,
      })),
      ...packTemplates.map((t) => ({
        // Null, not a fabricated id: a pack template has no row, and handing
        // back an id that PATCH would 404 on is worse than admitting there
        // isn't one. Editing one means creating an override.
        id: null,
        key: t.key,
        name: t.name,
        type: t.channel,
        subject: t.subject,
        content: t.body,
        variables: t.variables ?? [],
        source: 'config_pack' as const,
      })),
    ];
  }

  // ==================== SCHEDULED JOBS ====================

  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledNotifications(): Promise<void> {
    const now = new Date();

    const scheduled = await this.notificationRepo.find({
      where: {
        status: NotificationStatus.PENDING,
        scheduledAt: LessThan(now),
      },
    });

    for (const notification of scheduled) {
      this.eventEmitter.emit('notification.created', notification);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendDigestEmails(): Promise<void> {
    // Get users with digest enabled
    const users = await this.preferenceRepo.find();

    for (const user of users) {
      if (!user.digestSettings?.enabled) continue;

      const unread = await this.getNotifications(user.tenantId, user.userId, {
        isRead: false,
      });

      if (unread.notifications.length > 0) {
        // Send digest email
        await this.sendNotification({
          tenantId: user.tenantId,
          type: NotificationType.EMAIL,
          recipientId: user.userId,
          subject: `You have ${unread.total} unread notifications`,
          content: `You have ${unread.total} unread notifications. Log in to view them.`,
          category: NotificationCategory.SYSTEM,
        });
      }
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private shouldSendNotification(
    preferences: NotificationPreference,
    options: SendNotificationOptions,
  ): boolean {
    const category = options.category || NotificationCategory.SYSTEM;
    const categoryPref = preferences.categoryPreferences?.[category];
    if (!categoryPref?.enabled) return false;

    // Check if notification type is enabled for this category
    const allowedChannels = categoryPref.channels || [];
    if (!allowedChannels.includes(options.type)) return false;

    // Check channel-specific settings
    const channelSettings = preferences.channels?.[options.type.toLowerCase()];
    if (channelSettings && !channelSettings.enabled) return false;

    return true;
  }

  private isInQuietHours(preferences: NotificationPreference): boolean {
    if (!preferences.quietHours?.enabled) return false;

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const { startTime, endTime } = preferences.quietHours;

    if (startTime < endTime) {
      return currentTime >= startTime && currentTime <= endTime;
    } else {
      // Quiet hours span midnight
      return currentTime >= startTime || currentTime <= endTime;
    }
  }

  private getQuietHoursEnd(preferences: NotificationPreference): Date {
    const now = new Date();
    if (!preferences.quietHours?.endTime) {
      return now;
    }
    const [hours, minutes] = preferences.quietHours.endTime
      .split(':')
      .map(Number);
    const endTime = new Date(now);
    endTime.setHours(hours, minutes, 0, 0);

    if (endTime < now) {
      endTime.setDate(endTime.getDate() + 1);
    }

    return endTime;
  }

  private async scheduleNotification(
    options: SendNotificationOptions,
    scheduledAt: Date,
  ): Promise<Notification> {
    const notification = this.notificationRepo.create({
      tenantId: options.tenantId,
      type: options.type,
      status: NotificationStatus.PENDING,
      priority: options.priority || NotificationPriority.NORMAL,
      category: options.category || NotificationCategory.SYSTEM,
      recipientId: options.recipientId,
      subject: options.subject,
      content: options.content,
      metadata: options.metadata || {},
      templateData: options.templateData || {},
      scheduledAt,
      deliveryAttempts: [],
      retryCount: 0,
    });

    return this.notificationRepo.save(notification);
  }
}
