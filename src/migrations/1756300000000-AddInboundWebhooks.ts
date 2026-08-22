import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Generic inbound webhook receiver — the one place a third party can call
 * Meru. Before this the only inbound route was Stripe's, so a Cal.com,
 * signature-provider or WhatsApp delivery-receipt callback had nowhere to
 * land (meru-core-fe/AGENTS.md §11 item 8).
 *
 * Both tables are tenant-scoped with ENABLE + FORCE RLS (CLAUDE.md §8). The
 * public receive route looks the endpoint up as system and then binds the
 * endpoint's tenant before writing the event.
 */
export class AddInboundWebhooks1756300000000 implements MigrationInterface {
  name = 'AddInboundWebhooks1756300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inbound_webhook_endpoints" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "provider" character varying(60),
        "signatureScheme" character varying(30) NOT NULL DEFAULT 'hmac-sha256-hex',
        "signatureHeader" character varying(80),
        "secret" text NOT NULL,
        "eventTypePath" character varying(120),
        "active" boolean NOT NULL DEFAULT true,
        "lastReceivedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_inbound_webhook_endpoints_tenant" ON "inbound_webhook_endpoints" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inbound_webhook_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "endpointId" uuid NOT NULL,
        "receivedAt" TIMESTAMPTZ NOT NULL,
        "status" character varying(20) NOT NULL,
        "signatureValid" boolean,
        "eventType" character varying(120),
        "body" jsonb NOT NULL,
        "headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "sourceIp" character varying(64),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_inbound_webhook_events_tenant_endpoint" ON "inbound_webhook_events" ("tenantId","endpointId","receivedAt")`,
    );

    for (const table of ['inbound_webhook_endpoints', 'inbound_webhook_events']) {
      await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON "${table}" FOR ALL TO public
          USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
          WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "inbound_webhook_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inbound_webhook_endpoints"`);
  }
}
