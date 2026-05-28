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

  async sendFromTemplate(
    tenantId: string,
    templateKey: string,
    recipientId: string,
    variables: Record<string, any>,
  ): Promise<Notification | null> {
    const template = await this.templateRepo.findOne({
      where: { key: templateKey, tenantId },
    });

    if (!template) {
      throw new NotFoundException(`Template not found: ${templateKey}`);
    }

    // Replace variables in template
    let content = template.content;
    let subject = template.subject;

    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      content = content.replace(regex, String(value));
      subject = subject.replace(regex, String(value));
    });

    return this.sendNotification({
      tenantId,
      type: template.type as unknown as NotificationType,
      recipientId,
      subject,
      content,
      templateData: { templateId: template.id, variables },
    });
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

  async getTemplates(
    tenantId: string,
    type?: string,
  ): Promise<NotificationTemplate[]> {
    const where: any = { tenantId };
    if (type) where.type = type;

    return this.templateRepo.find({ where });
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
