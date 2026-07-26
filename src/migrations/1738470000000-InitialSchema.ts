import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1738470000000 implements MigrationInterface {
  name = 'InitialSchema1738470000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE "vertical_type_enum" AS ENUM('banking', 'healthcare', 'insurance', 'retail', 'government', 'education', 'other')
    `);

    await queryRunner.query(`
      CREATE TYPE "auth_provider_enum" AS ENUM('local', 'saml', 'google', 'microsoft')
    `);

    await queryRunner.query(`
      CREATE TYPE "entity_type_enum" AS ENUM('person', 'organization')
    `);

    // Create tenants table
    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "vertical" "vertical_type_enum" NOT NULL,
        "ssoConfig" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_4a0bd308202ab77c599c569c3a1" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_4a0bd308202ab77c599c569c3a2" ON "tenants" ("slug")
    `);

    // Create users table
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "email" character varying NOT NULL,
        "password" character varying NOT NULL,
        "provider" "auth_provider_enum" NOT NULL DEFAULT 'local',
        "roles" text NOT NULL DEFAULT 'user',
        "attributes" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_96aac66e14d3e4c7c2760c7cbb" ON "users" ("tenantId")
    `);

    // Create tenant_settings table
    await queryRunner.query(`
      CREATE TABLE "tenant_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "verticalConfig" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_8f0b9b1b1b0b9b9b9b9b9b9b9b9" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_8f0b9b1b1b0b9b9b9b9b9b9b9b" ON "tenant_settings" ("tenantId")
    `);

    // Create universal_entities table
    await queryRunner.query(`
      CREATE TABLE "universal_entities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "type" "entity_type_enum" NOT NULL,
        "firstName" character varying,
        "lastName" character varying,
        "email" character varying,
        "phoneNumber" character varying,
        "verticalAttributes" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_4c88e956195bba85977da21b8f4" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_4c88e956195bba85977da21b8f5" ON "universal_entities" ("tenantId", "email")
    `);

    // Add foreign key constraints
    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "FK_96aac66e14d3e4c7c2760c7cbb9" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "tenant_settings" ADD CONSTRAINT "FK_8f0b9b1b1b0b9b9b9b9b9b9b9b9" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "universal_entities" ADD CONSTRAINT "FK_4c88e956195bba85977da21b8f4a" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key constraints
    await queryRunner.query(
      `ALTER TABLE "universal_entities" DROP CONSTRAINT "FK_4c88e956195bba85977da21b8f4a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_settings" DROP CONSTRAINT "FK_8f0b9b1b1b0b9b9b9b9b9b9b9b9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_96aac66e14d3e4c7c2760c7cbb9"`,
    );

    // Drop tables
    await queryRunner.query(`DROP TABLE "universal_entities"`);
    await queryRunner.query(`DROP TABLE "tenant_settings"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "tenants"`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE "entity_type_enum"`);
    await queryRunner.query(`DROP TYPE "auth_provider_enum"`);
    await queryRunner.query(`DROP TYPE "vertical_type_enum"`);
  }
}
