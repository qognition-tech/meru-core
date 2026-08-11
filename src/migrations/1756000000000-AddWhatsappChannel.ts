import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `whatsapp` as a COM channel.
 *
 * Declared so a conversation can be *recorded* on it: WhatsApp is how a great
 * deal of immigration correspondence actually happens, and a thread that cannot
 * be keyed on it means the firm's record of what it told a client lives in
 * somebody's phone.
 *
 * **This does not send anything.** `NotificationDispatchService` fails a
 * non-email channel explicitly — "no transport configured for channel
 * 'whatsapp'" — rather than reporting `sent`. A channel that claims delivery
 * without a provider is the worst option available here, because a caseworker
 * would believe the client had been told. Sending needs a Meta Business account
 * and a WhatsApp-approved template, which is licensing rather than code.
 *
 * `ADD VALUE IF NOT EXISTS` is not transactional in older Postgres, so this
 * migration deliberately does nothing else — a partial failure leaves the enum
 * extended and nothing inconsistent.
 */
export class AddWhatsappChannel1756000000000 implements MigrationInterface {
  name = 'AddWhatsappChannel1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The enum backs `notifications.type`. `notification_templates.type` is a
    // separate, narrower enum (TemplateType) and is deliberately untouched:
    // there is no WhatsApp template rendering to do until there is a transport.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'whatsapp'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum. Removing it would mean
    // recreating the type, rewriting every dependent column and re-adding the
    // defaults — which risks the table to undo something inert. An unused enum
    // value costs nothing.
  }
}
