import { User } from '../iam/entities/user.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import {
  Notification,
  NotificationPreference,
  NotificationTemplate,
} from './entities/notification.entity';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { SequenceRunnerService } from './sequence-runner.service';
import { RuleEvaluatorModule } from '../rules/rule-evaluator.module';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { ThreadService } from './thread.service';
import { MessagingController } from './messaging.controller';
import { CommunicationsController } from './communications.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      NotificationTemplate,
      User,
      // The sequence runner reads the records it messages and the tenants it
      // sweeps; it owns the enrolment state.
      SequenceEnrolment,
      UniversalEntity,
      Tenant,
    ]),
    // Layer 4: the vertical's message templates and sequences.
    VerticalPackModule,
    // Sequence triggers, step conditions and stop conditions are JsonLogic.
    RuleEvaluatorModule,
  ],
  providers: [
    NotificationsService,
    NotificationDispatchService,
    SequenceRunnerService,
    ThreadService,
  ],
  controllers: [
    NotificationsController,
    CommunicationsController,
    MessagingController,
  ],
  exports: [
    NotificationsService,
    NotificationDispatchService,
    SequenceRunnerService,
    ThreadService,
  ],
})
export class NotificationsModule {}
