import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertFiring } from './entities/alert-firing.entity';
import { AlertRuleService } from './alert-rule.service';
import { RuleEvaluatorModule } from './rule-evaluator.module';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { User } from '../iam/entities/user.entity';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';

/**
 * The pack-driven rules layer.
 *
 * Top-level rather than a sub-module of WF, even though §5 of the parity map
 * sketched it there: the evaluator serves FORM validation and WF transitions
 * as well as alert rules, and hanging it off either one would make the other
 * import a module it has no business depending on — the shortest path to an
 * import cycle in a codebase that already needs several `forwardRef`s.
 *
 * `VerticalPackModule` rather than `TenantModule` for the same reason: reading
 * one JSON key should not drag Billing and Audit in behind it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AlertFiring, UniversalEntity, Tenant, User]),
    RuleEvaluatorModule,
    VerticalPackModule,
    NotificationsModule,
    TasksModule,
  ],
  providers: [AlertRuleService],
  exports: [AlertRuleService],
})
export class RulesModule {}
