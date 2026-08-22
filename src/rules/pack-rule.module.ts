import { Module } from '@nestjs/common';
import { PackRuleService } from './pack-rule.service';
import { RuleEvaluatorModule } from './rule-evaluator.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';

/**
 * `rules[]` evaluation, and nothing else.
 *
 * Separate from `RulesModule` for the reason that module's own header gives:
 * RulesModule drags NotificationsModule and TasksModule in behind the alert
 * sweep, and TasksModule reaches DocumentsModule, which reaches CrmModule.
 * Importing RulesModule from CrmModule closed that loop and took production
 * down with FUNCTION_INVOCATION_FAILED on every route (2026-08-22). This
 * module imports two leaf modules and can be imported from anywhere.
 */
@Module({
  imports: [RuleEvaluatorModule, VerticalPackModule],
  providers: [PackRuleService],
  exports: [PackRuleService],
})
export class PackRuleModule {}
