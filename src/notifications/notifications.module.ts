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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      NotificationTemplate,
      User,
    ]),
    // Layer 4: the vertical's message templates.
    VerticalPackModule,
  ],
  providers: [NotificationsService, NotificationDispatchService],
  controllers: [NotificationsController],
  exports: [NotificationsService, NotificationDispatchService],
})
export class NotificationsModule {}
