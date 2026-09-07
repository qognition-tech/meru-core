import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds `verticalAttributes.vacStatus` on existing immigration cases.
 *
 * The government charge — the Visa Application Charge — has three states, and
 * conflating any two of them is the failure `immistack/CLAUDE.md` §4.4 is
 * written to prevent:
 *
 *   unpaid            no evidence has been recorded. The default.
 *   evidence_pending  an artifact exists, nobody has verified it.
 *                     Renders "not verified" — NEVER "paid".
 *   verified          a staff member opened the artifact and confirmed it.
 *                     Requires verifiedBy, verifiedAt, and a receipt or a TRN.
 *
 * Why a backfill at all: `PackRuleService.evaluate` pushes a rule whose
 * variables the record does not carry into `skipped` and continues — no
 * violation, and `blocked` stays false. So the reconciliation rule shipped
 * against un-backfilled records would report **silence that reads like a pass**,
 * on precisely the question "was the government fee actually paid". The field
 * has to exist on every case before the rule that reads it exists at all, which
 * is why this migration lands before the pack entry.
 *
 * `unpaid` is the honest seed. It does not assert non-payment in the world; it
 * asserts that no evidence has been recorded *in this system*, which is exactly
 * true of every case predating the feature. It errs toward prompting a human,
 * never toward a clean result — CLAUDE.md §3.
 *
 * Vertical vocabulary lives in `verticalAttributes`, not a core column
 * (CLAUDE.md §5.5): core knows "a record that can be worked" and does not know
 * what a visa charge is. It is set at the TOP level of `verticalAttributes`
 * rather than nested under `matter`, because `PackRuleService` promotes that
 * object exactly one level — a nested `matter.vacStatus` would be invisible to
 * every rule that referenced it.
 *
 * Idempotent: only rows where the key is absent are touched, so re-running
 * cannot overwrite a status someone has since set by hand.
 */
export class BackfillVacStatus1756600000000 implements MigrationInterface {
  name = 'BackfillVacStatus1756600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "universal_entities"
         SET "verticalAttributes" =
             jsonb_set(
               COALESCE("verticalAttributes", '{}'::jsonb),
               '{vacStatus}',
               '"unpaid"'::jsonb,
               true
             )
       WHERE "type" = 'case'
         AND NOT (COALESCE("verticalAttributes", '{}'::jsonb) ? 'vacStatus')
    `);
  }

  /**
   * Removes only rows still carrying the seed this migration wrote.
   *
   * An earlier draft deleted `vacStatus` from every case that had the key and
   * called the collateral damage unavoidable. It is not: a case a staff member
   * has since verified — with a receipt or a TRN on file — would have lost that
   * attestation on a rollback, and the attestation is the whole point of the
   * field. Scoping to `= 'unpaid'` leaves every human decision intact and
   * removes only what was seeded.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "universal_entities"
         SET "verticalAttributes" = "verticalAttributes" - 'vacStatus'
       WHERE "type" = 'case'
         AND ("verticalAttributes"->>'vacStatus') = 'unpaid'
    `);
  }
}
