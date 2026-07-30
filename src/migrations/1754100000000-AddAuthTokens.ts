import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Single-use tokens for password reset and invite acceptance.
 *
 * Until now an invited user had no way to ever sign in: `inviteUser` created
 * the row with an unusable random password and there was no reset flow, so the
 * invite was a dead end. (Before that it returned the plaintext temp password
 * to the API caller, which was worse — anyone who could invite could
 * immediately authenticate as the invitee.)
 *
 * Only the SHA-256 of each token is stored, mirroring `sessions`. A database
 * dump must not yield a working set-password link for every pending invite.
 */
export class AddAuthTokens1754100000000 implements MigrationInterface {
  name = 'AddAuthTokens1754100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_tokens_type_enum') THEN
          CREATE TYPE "auth_tokens_type_enum" AS ENUM ('password_reset', 'invite');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_tokens" (
        "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"  VARCHAR NOT NULL,
        "userId"    UUID NOT NULL,
        "type"      "auth_tokens_type_enum" NOT NULL,
        "tokenHash" VARCHAR(128) NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "usedAt"    TIMESTAMPTZ,
        "issuedBy"  UUID,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Unique on the hash: the lookup is by hash, and two live tokens sharing
    // one would make redemption ambiguous.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_tokens_hash" ON "auth_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_tokens_user" ON "auth_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_tokens_tenant" ON "auth_tokens" ("tenantId")`,
    );

    // Tenant isolation, written explicitly: the catalog-driven loop in
    // AddTenantRowLevelSecurity has already run, so new tables do not inherit a
    // policy retroactively (CLAUDE.md §6.4).
    //
    // Note that redemption itself runs in a system context — a password-reset
    // link is presented by someone with no session, so no tenant is bound. The
    // policy still matters for every authenticated path that touches this table.
    await queryRunner.query(
      `ALTER TABLE "auth_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_tokens" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "auth_tokens"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "auth_tokens" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id())
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id())
    `);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_tokens" TO meru_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_tokens"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "auth_tokens_type_enum"`);
  }
}
