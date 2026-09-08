import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the `trade_instrument` entity type.
 *
 * Separate from AddEntityLifecycleColumns because that migration has already
 * run on deployed environments — TypeORM will not re-execute it, so amending
 * it in place would add the value on a fresh database and silently skip it
 * everywhere that matters.
 *
 * Trade finance instruments (letters of credit, guarantees, collections) are a
 * GovernanceX concern, so they get no core table: they are `universal_entities`
 * rows whose banking fields live in `verticalAttributes` (CLAUDE.md §11.3).
 * See src/integrations/services/trade.service.ts.
 */
export class AddTradeInstrumentType1754000000000 implements MigrationInterface {
  name = 'AddTradeInstrumentType1754000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS 'trade_instrument'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value; recreating the type would mean
    // rewriting every row that references it. The member is inert when unused.
  }
}
