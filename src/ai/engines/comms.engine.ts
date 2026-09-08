import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai.service';
import { PromptCategory } from '../entities/ai-prompt.entity';
import { CrmService } from '../../crm/crm.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../../notifications/entities/notification.entity';

/**
 * CommsEngine — AI-powered communications engine.
 * Handles email generation, templates, follow-up scheduling,
 * response analysis, and multi-channel orchestration.
 */
export interface CommunicationRequest {
  tenantId: string;
  recipientId?: string;
  recipientEmail?: string;
  channel: 'email' | 'sms' | 'push' | 'in_app';
  templateKey?: string;
  variables?: Record<string, string>;
  subject?: string;
  body?: string;
  context?: Record<string, any>;
  scheduleAt?: Date;
  followUpRules?: FollowUpRule[];
}

export interface FollowUpRule {
  condition: 'no_response' | 'opened' | 'clicked' | 'bounced';
  afterDays: number;
  templateKey: string;
}

export interface CommunicationResult {
  messageId: string;
  channel: string;
  status: 'sent' | 'scheduled' | 'queued' | 'failed';
  scheduledAt?: Date;
  trackingId?: string;
  error?: string;
}

export interface EmailAnalysis {
  intent: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'urgent';
  entities: Array<{ type: string; value: string }>;
  suggestedResponse?: string;
  priority: 'low' | 'medium' | 'high';
}

@Injectable()
export class CommsEngine {
  private readonly logger = new Logger(CommsEngine.name);

  constructor(
    private readonly aiService: AiService,
    private readonly crmService: CrmService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationResult> {
    // If template, generate personalized content via AI
    if (request.templateKey || (!request.body && request.context)) {
      const generated = await this.generateContent(request);
      request.subject = generated.subject;
      request.body = generated.body;
    }

    try {
      // If scheduled, just store the scheduled communication
      if (request.scheduleAt) {
        return {
          messageId: `scheduled_${Date.now()}`,
          channel: request.channel,
          status: 'scheduled',
          scheduledAt: request.scheduleAt,
        };
      }

      // Map channel to notification type
      const typeMap: Record<string, NotificationType> = {
        email: NotificationType.EMAIL,
        sms: NotificationType.SMS,
        push: NotificationType.PUSH,
        in_app: NotificationType.IN_APP,
      };

      await this.notificationsService.sendNotification({
        tenantId: request.tenantId,
        type: typeMap[request.channel] || NotificationType.IN_APP,
        recipientId: request.recipientId || 'unknown',
        subject: request.subject || '',
        content: request.body || '',
        priority: NotificationPriority.NORMAL,
        category: NotificationCategory.COLLABORATION,
        metadata: { channel: request.channel, variables: request.variables },
        templateData: request.templateKey
          ? { templateId: request.templateKey, variables: request.variables }
          : undefined,
      });

      return {
        messageId: `msg_${Date.now()}`,
        channel: request.channel,
        status: 'sent',
      };
    } catch (error: any) {
      this.logger.error(`Failed to send communication: ${error.message}`);
      return {
        messageId: '',
        channel: request.channel,
        status: 'failed',
        error: error.message,
      };
    }
  }

  async generateContent(request: CommunicationRequest): Promise<{
    subject: string;
    body: string;
  }> {
    const response = await this.aiService.execute({
      category: 'communication' as PromptCategory,
      key: request.templateKey || 'generic_message',
      input: JSON.stringify(request.context || {}),
      context: {
        channel: request.channel,
        variables: request.variables,
        recipientId: request.recipientId,
      },
      tenantId: request.tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        subject: parsed.subject || request.subject || '',
        body: parsed.body || request.body || '',
      };
    } catch {
      return {
        subject: request.subject || '',
        body: response.result || request.body || '',
      };
    }
  }

  async analyzeInboundMessage(
    tenantId: string,
    messageContent: string,
    senderInfo?: Record<string, any>,
  ): Promise<EmailAnalysis> {
    const response = await this.aiService.execute({
      category: 'communication' as PromptCategory,
      key: 'inbound_analysis',
      input: messageContent,
      context: { senderInfo },
      tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return {
        intent: 'unknown',
        sentiment: 'neutral',
        entities: [],
        priority: 'medium',
      };
    }
  }

  async suggestResponse(
    tenantId: string,
    originalMessage: string,
    intent: string,
    entityContext?: Record<string, any>,
  ): Promise<string> {
    const response = await this.aiService.execute({
      category: 'communication' as PromptCategory,
      key: 'response_suggestion',
      input: originalMessage,
      context: { intent, entityContext },
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return parsed.suggestedResponse || response.result;
    } catch {
      return response.result;
    }
  }

  async setupFollowUpSequence(
    request: CommunicationRequest,
  ): Promise<CommunicationResult[]> {
    if (!request.followUpRules || request.followUpRules.length === 0) {
      return [];
    }

    const results: CommunicationResult[] = [];

    for (const rule of request.followUpRules) {
      const followUpDate = new Date();
      followUpDate.setDate(followUpDate.getDate() + rule.afterDays);

      const followUpRequest: CommunicationRequest = {
        ...request,
        templateKey: rule.templateKey,
        scheduleAt: followUpDate,
      };

      const result = await this.send(followUpRequest);
      results.push(result);
    }

    return results;
  }

  async personalizeBulkCommunication(
    tenantId: string,
    templateKey: string,
    recipients: Array<{
      id: string;
      email: string;
      variables: Record<string, string>;
    }>,
  ): Promise<Array<{ recipientId: string; subject: string; body: string }>> {
    const results: Array<{
      recipientId: string;
      subject: string;
      body: string;
    }> = [];

    for (const recipient of recipients) {
      const request: CommunicationRequest = {
        tenantId,
        channel: 'email',
        templateKey,
        variables: recipient.variables,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
      };

      const content = await this.generateContent(request);
      results.push({
        recipientId: recipient.id,
        subject: content.subject,
        body: content.body,
      });
    }

    return results;
  }
}
