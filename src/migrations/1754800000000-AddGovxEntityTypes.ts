import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entity types backing nine GovernanceX module areas.
 *
 * These are types on `universal_entities`, not new modules: each is a record
 * with a status, an owner and a date, which is exactly what the CRM module
 * already models. Vocabulary, fields and lifecycle live in the banking config
 * pack (CLAUDE.md §11.3 — the horizontal engine must not learn a vertical's
 * language). One migration therefore gives Knowledge Base, Training, Vendor
 * Due Diligence, Control Testing, Risk Workshop, Milestones, Turnover
 * Monitoring, RFI and Match Review their whole data layer, reachable through
 * the existing `/crm/entities` API with tenant isolation already enforced.
 */
export class AddGovxEntityTypes1754800000000 implements MigrationInterface {
  name = 'AddGovxEntityTypes1754800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = [
      'knowledge_article',
      'training_module',
      'vendor',
      'control_test',
      'risk_scenario',
      'milestone',
      'turnover_record',
      'rfi',
      'screening_match',
    ];

    // ADD VALUE cannot run inside a transaction block on older servers and
    // must be one statement per value.
    for (const type of types) {
      await queryRunner.query(
        `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS '${type}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value; recreating the type would mean
    // rewriting every row that references it. Members are inert when unused.
  }
}
