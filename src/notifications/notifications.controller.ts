import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { NotificationsService } from './notifications.service';
import {
  CreateNotificationDto,
  SendBulkNotificationsDto,
  NotificationQueryDto,
  UpdateNotificationPreferencesDto,
  CreateTemplateDto,
  MarkAsReadDto,
} from './dto/notification.dto';
import { PolicyGuard } from '../iam/guards/policy.guard';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  // ==================== NOTIFICATION MANAGEMENT ====================

  @Post()
  @ApiOperation({
    summary: 'Send a notification',
    description:
      'Send a single notification to a user. The notification will be delivered based on user preferences and channel availability.',
  })
  @ApiResponse({
    status: 201,
    description: 'Notification created successfully',
    schema: {
      example: {
        success: true,
        data: {
          id: 'notif-123',
          type: 'email',
          status: 'pending',
          recipientId: 'user-456',
          subject: 'New Task Assigned',
          content: 'You have been assigned a new task',
          createdAt: '2024-01-15T10:30:00Z',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async sendNotification(@Request() req, @Body() dto: CreateNotificationDto) {
    const notification = await this.notificationsService.sendNotification({
      ...dto,
      tenantId: req.user.tenantId,
    });
    return { success: true, data: notification };
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Send bulk notifications',
    description:
      'Send multiple notifications in a single request. Useful for broadcast messages or batch updates.',
  })
  @ApiResponse({
    status: 201,
    description: 'Bulk notifications sent successfully',
    schema: {
      example: {
        success: true,
        data: {
          sent: 100,
          failed: 2,
          notifications: [
            { id: 'notif-1', status: 'pending' },
            { id: 'notif-2', status: 'pending' },
          ],
        },
      },
    },
  })
  async sendBulkNotifications(
    @Request() req,
    @Body() dto: SendBulkNotificationsDto,
  ) {
    const notifications = await this.notificationsService.sendBulkNotifications(
      req.user.tenantId,
      dto.notifications.map((n) => ({ ...n, tenantId: req.user.tenantId })),
    );
    return {
      success: true,
      data: {
        sent: notifications.length,
        notifications,
      },
    };
  }

  @Post('template/:templateKey')
  @ApiOperation({
    summary: 'Send notification from template',
    description:
      'Send a notification using a pre-defined template with variable substitution.',
  })
  @ApiParam({
    name: 'templateKey',
    description: 'Unique key of the template to use',
    example: 'welcome-email',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        recipientId: { type: 'string', example: 'user-123' },
        variables: {
          type: 'object',
          example: { name: 'John', company: 'Acme Inc' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Notification sent from template' })
  async sendFromTemplate(
    @Request() req,
    @Param('templateKey') templateKey: string,
    @Body() body: { recipientId: string; variables: Record<string, any> },
  ) {
    const notification = await this.notificationsService.sendFromTemplate(
      req.user.tenantId,
      templateKey,
      body.recipientId,
      body.variables,
    );
    return { success: true, data: notification };
  }

  // ==================== NOTIFICATION QUERY ====================

  @Get()
  @ApiOperation({
    summary: 'Get user notifications',
    description:
      'Retrieve notifications for the authenticated user with filtering and pagination options.',
  })
  @ApiQuery({
    name: 'type',
    enum: ['email', 'sms', 'push', 'in_app', 'slack'],
    required: false,
  })
  @ApiQuery({
    name: 'status',
    enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
    required: false,
  })
  @ApiQuery({
    name: 'category',
    enum: ['system', 'workflow', 'task', 'billing', 'security'],
    required: false,
  })
  @ApiQuery({
    name: 'isRead',
    type: 'boolean',
    required: false,
    description: 'Filter by read status',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false, default: 1 })
  @ApiQuery({ name: 'limit', type: 'number', required: false, default: 20 })
  @ApiResponse({
    status: 200,
    description: 'Notifications retrieved successfully',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 'notif-123',
            type: 'email',
            status: 'sent',
            subject: 'New Task Assigned',
            content: 'You have a new task to review',
            createdAt: '2024-01-15T10:30:00Z',
            readAt: null,
          },
        ],
        meta: {
          total: 45,
          page: 1,
          limit: 20,
          unreadCount: 12,
        },
      },
    },
  })
  async getNotifications(@Request() req, @Query() query: NotificationQueryDto) {
    const { notifications, total } =
      await this.notificationsService.getNotifications(
        req.user.tenantId,
        req.user.id,
        {
          type: query.type,
          status: query.status,
          category: query.category,
          isRead: query.isRead,
          page: query.page,
          limit: query.limit,
        },
      );

    const unreadCount = await this.notificationsService.getUnreadCount(
      req.user.tenantId,
      req.user.id,
    );

    return {
      success: true,
      data: notifications,
      meta: {
        total,
        page: query.page || 1,
        limit: query.limit || 20,
        unreadCount,
      },
    };
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Get unread notification count',
    description:
      'Get the total number of unread notifications for the current user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Unread count retrieved',
    schema: {
      example: {
        success: true,
        data: { count: 12 },
      },
    },
  })
  async getUnreadCount(@Request() req) {
    const count = await this.notificationsService.getUnreadCount(
      req.user.tenantId,
      req.user.id,
    );
    return { success: true, data: { count } };
  }

  // ==================== NOTIFICATION ACTIONS ====================

  @Post('mark-as-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark notifications as read',
    description: 'Mark one or more notifications as read.',
  })
  @ApiResponse({ status: 200, description: 'Notifications marked as read' })
  async markAsRead(@Request() req, @Body() dto: MarkAsReadDto) {
    await this.notificationsService.markAsRead(
      dto.notificationIds,
      req.user.id,
    );
    return { success: true, message: 'Notifications marked as read' };
  }

  @Post('mark-all-as-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all notifications as read',
    description: 'Mark all unread notifications for the current user as read.',
  })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  async markAllAsRead(@Request() req) {
    await this.notificationsService.markAllAsRead(
      req.user.tenantId,
      req.user.id,
    );
    return { success: true, message: 'All notifications marked as read' };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a notification',
    description: 'Soft delete a specific notification.',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async deleteNotification(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.notificationsService.deleteNotification(id, req.user.id);
    return { success: true, message: 'Notification deleted' };
  }

  // ==================== PREFERENCES ====================

  @Get('preferences')
  @ApiOperation({
    summary: 'Get notification preferences',
    description:
      'Get the current notification preferences for the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Preferences retrieved',
    schema: {
      example: {
        success: true,
        data: {
          channels: {
            email: {
              enabled: true,
              address: 'user@example.com',
              verified: true,
            },
            push: { enabled: true, deviceTokens: ['token1'] },
          },
          categoryPreferences: {
            workflow: { enabled: true, channels: ['email', 'in_app'] },
            billing: { enabled: true, channels: ['email'] },
          },
          quietHours: { enabled: false },
          digestSettings: { enabled: true, frequency: 'daily' },
        },
      },
    },
  })
  async getPreferences(@Request() req) {
    const preferences = await this.notificationsService.getUserPreferences(
      req.user.tenantId,
      req.user.id,
    );
    return { success: true, data: preferences };
  }

  @Put('preferences')
  @ApiOperation({
    summary: 'Update notification preferences',
    description:
      'Update notification preferences including channels, categories, quiet hours, and digest settings.',
  })
  @ApiResponse({ status: 200, description: 'Preferences updated successfully' })
  async updatePreferences(
    @Request() req,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    const preferences = await this.notificationsService.updatePreferences(
      req.user.tenantId,
      req.user.id,
      dto,
    );
    return { success: true, data: preferences };
  }

  // ==================== TEMPLATES ====================

  @Post('templates')
  @ApiOperation({
    summary: 'Create notification template',
    description:
      'Create a new notification template for reusable notifications.',
  })
  @ApiResponse({
    status: 201,
    description: 'Template created successfully',
    schema: {
      example: {
        success: true,
        data: {
          id: 'template-123',
          name: 'Welcome Email',
          key: 'welcome-email',
          type: 'email',
          subject: 'Welcome {{name}}!',
          content: 'Hello {{name}}, welcome to {{company}}!',
        },
      },
    },
  })
  async createTemplate(@Request() req, @Body() dto: CreateTemplateDto) {
    const template = await this.notificationsService.createTemplate(
      req.user.tenantId,
      dto,
    );
    return { success: true, data: template };
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Get notification templates',
    description:
      'Get all notification templates for the tenant, optionally filtered by type.',
  })
  @ApiQuery({ name: 'type', enum: ['email', 'sms', 'push'], required: false })
  @ApiResponse({ status: 200, description: 'Templates retrieved successfully' })
  async getTemplates(@Request() req, @Query('type') type?: string) {
    const templates = await this.notificationsService.getTemplates(
      req.user.tenantId,
      type,
    );
    return { success: true, data: templates };
  }
}
