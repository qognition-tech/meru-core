import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notifications.threadKey` + `direction` — the two columns that turn a
 * one-way delivery log into a conversation.
 *
 * COM could record that a message went out and nothing else. There was no key
 * to group by, so "show me this client's correspondence" had no query, and the
 * frontend reduced two ImmiStack inboxes to a "not available yet" panel — one
 * of which had previously shipped a fabricated mailbox. That is the compliance
 * gap the module exists to close: staff fall back to their own mail client and
 * the firm's record of what was said to a client is incomplete.
 *
 * The key is `channel:counterparty`, per the frontend's stated minimum shape of
 * (tenant, counterparty, channel). Tenant is not in the key because it is
 * already a column and RLS already scopes it; folding it in would only make the
 * key unreadable.
 *
 * Existing rows are backfilled with the same derivation rather than left null,
 * because a thread list that starts empty on a table with history looks like a
 * broken feature. `direction` defaults to `outbound`: every row that exists
 * today was sent by the platform, and inbound only becomes possible when a
 * provider webhook lands.
 */
export class AddNotificationThreads1755800000000 implements MigrationInterface {
  name = 'AddNotificationThreads1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD COLUMN IF NOT EXISTS "threadKey" character varying(200),
        ADD COLUMN IF NOT EXISTS "direction" character varying(10) NOT NULL DEFAULT 'outbound'
    `);

    // Same derivation as ThreadService.deriveKey. Lower-cased because an email
    // address differing only in case is the same counterparty, and two threads
    // for one person is the failure mode this whole change is fixing.
    await queryRunner.query(`
      UPDATE "notifications"
      SET "threadKey" =
        "type"::text || ':' ||
        lower(COALESCE(NULLIF("recipientEmail", ''), NULLIF("recipientPhone", ''), "recipientId"))
      WHERE "threadKey" IS NULL
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_thread" ON "notifications" ("tenantId", "threadKey", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_thread"`,
    );
    await queryRunner.query(`
      ALTER TABLE "notifications"
        DROP COLUMN IF EXISTS "threadKey",
        DROP COLUMN IF EXISTS "direction"
    `);
  }
}
