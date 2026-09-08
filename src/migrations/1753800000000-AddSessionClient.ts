import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Label each session with the product that opened it.
 *
 * ImmiStack, the Meru Dashboard and GovernanceX are three separate frontends
 * against one API, and one person legitimately holds a session in each — so
 * concurrent sessions stay allowed. But "allowed" is only safe if a user can
 * see them and revoke one, and a list of three identical unlabelled rows is
 * not something anyone can act on.
 *
 * `ipAddress` and `userAgent` already existed but were written as empty
 * strings by `createSession`, so the columns were dead. They are populated
 * from the request now; this adds the missing piece, which is *which app*.
 */
export class AddSessionClient1753800000000 implements MigrationInterface {
  name = 'AddSessionClient1753800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "client" VARCHAR(64)`,
    );

    // "Show me my active sessions" is the only query this table gets outside
    // the token path, and it always filters on the owner.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sessions_user_active"
        ON "sessions" ("userId")
        WHERE "revokedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_user_active"`);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN IF EXISTS "client"`,
    );
  }
}
