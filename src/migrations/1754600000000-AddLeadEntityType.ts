import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `lead` joins the workable entity types (status + dueDate + assignee
 * lifecycle) so ImmiStack's Leads page binds to /crm/entities?type=lead the
 * same way cases/obligations/breaches do — the §2 handoff decision: type enum
 * extension, not a bespoke /leads resource.
 */
export class AddLeadEntityType1754600000000 implements MigrationInterface {
  name = 'AddLeadEntityType1754600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS 'lead'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value; recreating the type would mean
    // rewriting every row that references it. The member is inert when unused.
  }
}
