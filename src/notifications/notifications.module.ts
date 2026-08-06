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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      NotificationTemplate,
      User,
    ]),
  ],
  providers: [NotificationsService, NotificationDispatchService],
  controllers: [NotificationsController],
  exports: [NotificationsService, NotificationDispatchService],
})
export class NotificationsModule {}
