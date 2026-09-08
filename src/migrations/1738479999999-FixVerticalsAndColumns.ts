import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixVerticalsAndColumns1738479999999 implements MigrationInterface {
  name = 'FixVerticalsAndColumns1738479999999';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "vertical_type_enum" RENAME TO "vertical_type_enum_old"
    `);

    await queryRunner.query(`
      CREATE TYPE "vertical_type_enum" AS ENUM('immigration', 'grc', 'labour')
    `);

    await queryRunner.query(`
      ALTER TABLE "tenants" 
      ALTER COLUMN "vertical" TYPE "vertical_type_enum" 
      USING "vertical"::text::"vertical_type_enum"
    `);

    await queryRunner.query(`
      DROP TYPE "vertical_type_enum_old"
    `);

    await queryRunner.query(`
      ALTER TABLE "tenant_settings" RENAME COLUMN "verticalConfig" TO "config"
    `);

    await queryRunner.query(`
      ALTER TABLE "universal_entities" ADD COLUMN IF NOT EXISTS "relationships" jsonb DEFAULT '[]'
    `);

    // Drop the scalar default before changing type — a text default ('user')
    // cannot be cast automatically to text[].
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" TYPE text[] USING string_to_array(roles, ',')
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" SET DEFAULT '{user}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "vertical_type_enum" RENAME TO "vertical_type_enum_new"
    `);

    await queryRunner.query(`
      CREATE TYPE "vertical_type_enum" AS ENUM('banking', 'healthcare', 'insurance', 'retail', 'government', 'education', 'other')
    `);

    await queryRunner.query(`
      ALTER TABLE "tenants" 
      ALTER COLUMN "vertical" TYPE "vertical_type_enum" 
      USING "vertical"::text::"vertical_type_enum"
    `);

    await queryRunner.query(`
      DROP TYPE "vertical_type_enum_new"
    `);

    await queryRunner.query(`
      ALTER TABLE "tenant_settings" RENAME COLUMN "config" TO "verticalConfig"
    `);

    await queryRunner.query(`
      ALTER TABLE "universal_entities" DROP COLUMN "relationships"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" TYPE text USING array_to_string(roles, ',')
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "roles" SET DEFAULT 'user'
    `);
  }
}
