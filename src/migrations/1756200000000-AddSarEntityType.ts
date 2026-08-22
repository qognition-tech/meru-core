import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `sar` on `universal_entities.type` — a suspicious-activity report.
 *
 * A SAR is a worked record: a subject, a filing deadline, an owner and a
 * lifecycle, which is what the CRM module already models. It is an entity
 * type rather than a module because the vocabulary — what the form asks, what
 * the statuses are called, which regulator receives it — belongs to the GRC
 * config pack (CLAUDE.md §5.5), and core only learns that such a record can
 * be worked. GovX has a SAR page that 400'd three times per render for want
 * of this value.
 *
 * `ADD VALUE IF NOT EXISTS` is not transactional on older Postgres, so this
 * migration deliberately does nothing else.
 */
export class AddSarEntityType1756200000000 implements MigrationInterface {
  name = 'AddSarEntityType1756200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS 'sar'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum. Removing it would mean
    // recreating the type and rewriting every dependent column to undo
    // something inert. An unused enum value costs nothing — same reasoning as
    // AddGovxEntityTypes and AddWhatsappChannel.
  }
}
