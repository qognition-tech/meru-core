import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  WorkflowInstance,
  InstanceStatus,
} from '../entities/workflow-instance.entity';
import { WorkflowEngineService } from '../workflow.service';

@Injectable()
export class SlaWatchdogService {
  private readonly logger = new Logger(SlaWatchdogService.name);

  constructor(
    @InjectRepository(WorkflowInstance)
    private instanceRepo: Repository<WorkflowInstance>,
    private workflowService: WorkflowEngineService,
  ) {}

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
        this.logger.log(`Notifying: ${escalation.notify.join(', ')}`);
        // TODO: Integrate with notification service
        break;
      case 'escalate':
        this.logger.log(`Escalating to higher authority`);
        // TODO: Reassign to manager or escalate to higher level
        break;
      case 'auto_approve':
        this.logger.log(`Auto-approving due to SLA breach`);
        // TODO: Execute auto-transition
        break;
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
