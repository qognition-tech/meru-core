import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsDate,
  IsArray,
  IsEmail,
  IsPhoneNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../entities/notification.entity';

export class CreateNotificationDto {
  @ApiProperty({
    enum: NotificationType,
    description: 'Type of notification channel',
    example: NotificationType.EMAIL,
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({
    enum: NotificationPriority,
    description: 'Priority level of the notification',
    default: NotificationPriority.NORMAL,
    example: NotificationPriority.HIGH,
  })
  @IsEnum(NotificationPriority)
  @IsOptional()
  priority?: NotificationPriority;

  @ApiProperty({
    enum: NotificationCategory,
    description: 'Category of the notification',
    default: NotificationCategory.SYSTEM,
    example: NotificationCategory.WORKFLOW,
  })
  @IsEnum(NotificationCategory)
  @IsOptional()
  category?: NotificationCategory;

  @ApiProperty({ description: 'ID of the recipient user', example: 'user-123' })
  @IsString()
  recipientId: string;

  @ApiPropertyOptional({
    description: 'Email address of the recipient',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsOptional()
  recipientEmail?: string;

  @ApiPropertyOptional({
    description: 'Phone number of the recipient',
    example: '+1234567890',
  })
  @IsPhoneNumber()
  @IsOptional()
  recipientPhone?: string;

  @ApiProperty({
    description: 'Subject of the notification',
    example: 'New Task Assigned',
  })
  @IsString()
  subject: string;

  @ApiProperty({
    description: 'Content/body of the notification',
    example: 'You have been assigned a new task: Review Q4 Report',
  })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'HTML content for email notifications' })
  @IsString()
  @IsOptional()
  htmlContent?: string;

  @ApiPropertyOptional({
    description: 'Template data for variable substitution',
    example: {
      templateId: 'welcome-email',
      variables: { name: 'John', company: 'Acme' },
    },
  })
  @IsObject()
  @IsOptional()
  templateData?: {
    templateId?: string;
    variables?: Record<string, any>;
    locale?: string;
  };

  @ApiPropertyOptional({
    description: 'Additional metadata for the notification',
    example: {
      actionUrl: '/tasks/123',
      actionLabel: 'View Task',
      icon: 'task-icon',
      tags: ['urgent', 'workflow'],
    },
  })
  @IsObject()
  @IsOptional()
  metadata?: {
    actionUrl?: string;
    actionLabel?: string;
    icon?: string;
    imageUrl?: string;
    tags?: string[];
    customData?: Record<string, any>;
  };

  @ApiPropertyOptional({
    description: 'Schedule the notification for a future time',
    example: '2024-12-31T23:59:59Z',
  })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  scheduledAt?: Date;

  @ApiPropertyOptional({
    description: 'Expiration time for the notification',
    example: '2025-01-31T23:59:59Z',
  })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  expiresAt?: Date;
}

export class SendBulkNotificationsDto {
  @ApiProperty({
    type: [CreateNotificationDto],
    description: 'Array of notifications to send',
  })
  @IsArray()
  notifications: CreateNotificationDto[];
}

export class NotificationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by recipient ID' })
  @IsString()
  @IsOptional()
  recipientId?: string;

  @ApiPropertyOptional({
    enum: NotificationType,
    description: 'Filter by notification type',
  })
  @IsEnum(NotificationType)
  @IsOptional()
  type?: NotificationType;

  @ApiPropertyOptional({
    enum: NotificationStatus,
    description: 'Filter by status',
  })
  @IsEnum(NotificationStatus)
  @IsOptional()
  status?: NotificationStatus;

  @ApiPropertyOptional({
    enum: NotificationCategory,
    description: 'Filter by category',
  })
  @IsEnum(NotificationCategory)
  @IsOptional()
  category?: NotificationCategory;

  @ApiPropertyOptional({ description: 'Filter by read status', example: false })
  @IsOptional()
  isRead?: boolean;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  limit?: number;
}

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({
    description: 'Channel preferences',
    example: {
      email: { enabled: true, address: 'user@example.com', verified: true },
      sms: { enabled: false, phoneNumber: '+1234567890', verified: false },
      push: { enabled: true, deviceTokens: ['token1', 'token2'] },
      slack: {
        enabled: true,
        webhookUrl: 'https://hooks.slack.com/...',
        channel: '#notifications',
      },
    },
  })
  @IsObject()
  @IsOptional()
  channels?: any;

  @ApiPropertyOptional({ description: 'Category-specific preferences' })
  @IsObject()
  @IsOptional()
  categoryPreferences?: any;

  @ApiPropertyOptional({ description: 'Quiet hours settings' })
  @IsObject()
  @IsOptional()
  quietHours?: any;

  @ApiPropertyOptional({ description: 'Digest email settings' })
  @IsObject()
  @IsOptional()
  digestSettings?: any;
}

export class CreateTemplateDto {
  @ApiProperty({ description: 'Template name', example: 'Welcome Email' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Unique template key', example: 'welcome-email' })
  @IsString()
  key: string;

  @ApiProperty({ enum: TemplateType, description: 'Template type' })
  @IsEnum(TemplateType)
  type: TemplateType;

  @ApiProperty({ description: 'Email subject', example: 'Welcome to Meru!' })
  @IsString()
  subject: string;

  @ApiProperty({
    description: 'Template content with variables',
    example: 'Hello {{name}}, welcome to {{company}}!',
  })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'HTML version of the template' })
  @IsString()
  @IsOptional()
  htmlContent?: string;

  @ApiPropertyOptional({ description: 'Template variables definition' })
  @IsArray()
  @IsOptional()
  variables?: any[];
}

export class MarkAsReadDto {
  @ApiProperty({ description: 'Array of notification IDs to mark as read' })
  @IsArray()
  @IsString({ each: true })
  notificationIds: string[];
}

// Import NotificationStatus for the query DTO
import { NotificationStatus } from '../entities/notification.entity';
import { TemplateType } from '../entities/notification.entity';
