import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `document_versions.storageProvider` — which object store holds the bytes.
 *
 * DocumentsService used to construct its own `aws-sdk` S3 client, bypassing
 * StorageModule, so every version was implicitly S3 and the `s3Key`/`s3Bucket`
 * columns said so in their names. Documents now go through StorageService and
 * the tenant's configured driver (S3 or Supabase Storage), so each version
 * records where it went. Nullable: a pre-existing row resolves to the platform
 * default driver, which is the only one that existed when it was written.
 */
export class AddDocumentVersionStorageProvider1756100000000
  implements MigrationInterface
{
  name = 'AddDocumentVersionStorageProvider1756100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "storageProvider" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_versions" DROP COLUMN IF EXISTS "storageProvider"`,
    );
  }
}
