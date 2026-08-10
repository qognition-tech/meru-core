import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  WorkflowInstance,
  InstanceStatus,
} from '../entities/workflow-instance.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../../notifications/entities/notification.entity';
import { WorkflowEngineService } from '../workflow.service';

@Injectable()
export class SlaWatchdogService {
  private readonly logger = new Logger(SlaWatchdogService.name);

  constructor(
    @InjectRepository(WorkflowInstance)
    private instanceRepo: Repository<WorkflowInstance>,
    private workflowService: WorkflowEngineService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Notify the configured recipients of an SLA breach.
   *
   * `escalation.notify` holds user ids (or the literal 'assignee', resolved
   * from the instance). Delivery itself is the dispatcher's job — this only
   * records the intent, so a failing transport cannot stop the watchdog from
   * processing the rest of the breaches.
   */
  private async notifyRecipients(
    instance: WorkflowInstance,
    notify: string[],
    kind: 'notify' | 'escalate',
  ): Promise<void> {
    const recipients = new Set(
      (notify ?? [])
        // WorkflowInstance has no assignee column — `startedBy` is the only
        // person the instance actually names. Resolving 'assignee' to
        // anything else would be inventing a relationship.
        .map((n) => (n === 'assignee' ? instance.startedBy : n))
        .filter((n): n is string => !!n),
    );

    if (recipients.size === 0) {
      this.logger.warn(
        `SLA breach on instance ${instance.id} has no resolvable recipient`,
      );
      return;
    }

    const subject =
      kind === 'escalate'
        ? `Escalated: SLA breach on workflow ${instance.workflowId}`
        : `SLA breach on workflow ${instance.workflowId}`;

    for (const recipientId of recipients) {
      try {
        await this.notificationsService.sendNotification({
          tenantId: instance.tenantId,
          type: NotificationType.EMAIL,
          recipientId,
          subject,
          content:
            `Workflow instance ${instance.id} breached its SLA at ` +
            `escalation level ${instance.escalationLevel ?? 1}. ` +
            `Current state: ${instance.currentStateId ?? 'unknown'}.`,
          priority:
            kind === 'escalate'
              ? NotificationPriority.URGENT
              : NotificationPriority.HIGH,
          category: NotificationCategory.WORKFLOW,
          metadata: {
            workflowInstanceId: instance.id,
            workflowId: instance.workflowId,
            escalationLevel: instance.escalationLevel,
          },
        });
      } catch (err) {
        this.logger.error(
          `Failed to queue SLA notification for ${recipientId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSLAViolations() {
    this.logger.log('Running SLA violation check...');

    const now = new Date();

    // Find instances with expired SLA deadlines
    const violations = await this.instanceRepo.find({
      where: {
        status: InstanceStatus.ACTIVE,
        slaDeadline: LessThan(now),
      },
      relations: ['workflow', 'currentState'],
    });

    this.logger.log(`Found ${violations.length} SLA violations`);

    for (const instance of violations) {
      await this.processEscalation(instance);
    }
  }

  private async processEscalation(instance: WorkflowInstance): Promise<void> {
    const escalationLevel = instance.escalationLevel + 1;
    const escalationConfig =
      instance.workflow.slaConfig?.escalationLevels?.find(
        (e) => e.level === escalationLevel,
      );

    if (!escalationConfig) {
      this.logger.warn(
        `No escalation config found for level ${escalationLevel} on workflow ${instance.workflowId}`,
      );
      return;
    }

    this.logger.warn(
      `Processing SLA violation for instance ${instance.id}: Level ${escalationLevel}`,
    );

    // Update instance with violation
    instance.slaViolations.push({
      level: escalationLevel,
      timestamp: new Date(),
      action: escalationConfig.action,
    });

    await this.instanceRepo.update(instance.id, {
      escalationLevel,
      slaViolations: instance.slaViolations,
    });

    // Execute escalation actions
    await this.executeEscalationActions(instance, escalationConfig);
  }

  private async executeEscalationActions(
    instance: WorkflowInstance,
    escalation: { action: string; notify: string[] },
  ): Promise<void> {
    switch (escalation.action) {
      case 'notify':
        // Was a log line and a TODO: an SLA breach was detected and then
        // told to nobody, which makes the whole watchdog decorative. COM
        // only started delivering recently, so this could not be wired
        // before.
        await this.notifyRecipients(instance, escalation.notify, 'notify');
        break;
      case 'escalate':
        // Escalation notifies the same recipient list at high priority.
        // Reassignment to a manager needs an org hierarchy the IAM module
        // does not model yet, so it is deliberately not faked here.
        await this.notifyRecipients(instance, escalation.notify, 'escalate');
        break;
      case 'auto_approve': {
        // Take the first transition out of the current state, as the
        // configured actor. Deliberately only the first: an auto-approval that
        // guessed between two branches would be inventing a decision nobody
        // made, and an unmoved instance is recoverable where a wrongly
        // approved one is not.
        const moved = await this.workflowService
          .getAvailableTransitions(instance.id)
          .then((available) => available[0])
          .catch(() => undefined);

        if (!moved) {
          this.logger.warn(
            `Cannot auto-approve instance ${instance.id}: no available transition`,
          );
          break;
        }

        await this.workflowService.transition({
          instanceId: instance.id,
          transitionId: moved.id,
          userId: instance.startedBy,
          context: { autoApprovedBySlaBreach: true },
        });
        this.logger.log(
          `Auto-approved instance ${instance.id} via transition ${moved.id} after SLA breach`,
        );
        break;
      }
      case 'cancel':
        this.logger.log(`Cancelling workflow due to SLA breach`);
        await this.instanceRepo.update(instance.id, {
          status: InstanceStatus.CANCELLED,
        });
        break;
      default:
        this.logger.log(`Unknown escalation action: ${escalation.action}`);
    }
  }
}
