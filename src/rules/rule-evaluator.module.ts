import { Module } from '@nestjs/common';
import { RuleEvaluatorService } from './rule-evaluator.service';

/**
 * The condition evaluator on its own, for any module that needs to ask "is
 * this pack rule true of this record?".
 *
 * Split out of `RulesModule` for the same reason `VerticalPackModule` is split
 * out of `TenantModule`: COM's sequence runner needs the evaluator, and
 * `RulesModule` needs COM to send alert notifications. Importing the whole of
 * either would be a cycle. This module has one provider and no dependencies at
 * all, so nothing can import a cycle through it.
 */
@Module({
  providers: [RuleEvaluatorService],
  exports: [RuleEvaluatorService],
})
export class RuleEvaluatorModule {}
