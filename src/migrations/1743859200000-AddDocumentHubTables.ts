import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class AddDocumentHubTables1743859200000 implements MigrationInterface {
  name = 'AddDocumentHubTables1743859200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'documents',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'tenantId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'slug',
            type: 'varchar',
            isUnique: true,
            isNullable: false,
          },
          {
            name: 'fileType',
            type: 'enum',
            enum: ['pdf', 'jpg', 'jpeg', 'png', 'docx', 'xlsx', 'txt'],
            isNullable: false,
          },
          {
            name: 'originalFileName',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'fileSize',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'mimeType',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['active', 'archived', 'deleted'],
            default: "'active'",
            isNullable: false,
          },
          {
            name: 'encryption',
            type: 'enum',
            enum: ['none', 'standard', 'high'],
            default: "'none'",
            isNullable: false,
          },
          {
            name: 'requiredEncryption',
            type: 'enum',
            enum: ['none', 'standard', 'high'],
            default: "'none'",
            isNullable: false,
          },
          {
            name: 'linkedEntityType',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'linkedEntityId',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'tags',
            type: 'jsonb',
            default: "'[]'",
          },
          {
            name: 'metadata',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'aiAnalysis',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'rbac',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'versionNumber',
            type: 'int',
            default: 1,
          },
          {
            name: 'currentVersionId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'uploadedById',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'deletedAt',
            type: 'timestamp',
            isNullable: true,
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'documents',
      new TableIndex({
        name: 'IDX_DOCUMENTS_TENANT_STATUS',
        columnNames: ['tenantId', 'status'],
      }),
    );

    await queryRunner.createIndex(
      'documents',
      new TableIndex({
        name: 'IDX_DOCUMENTS_LINKED_ENTITY',
        columnNames: ['tenantId', 'linkedEntityType', 'linkedEntityId'],
      }),
    );

    await queryRunner.createForeignKey(
      'documents',
      new TableForeignKey({
        columnNames: ['tenantId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'tenants',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'documents',
      new TableForeignKey({
        columnNames: ['uploadedById'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'document_versions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'documentId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'versionNumber',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['draft', 'active', 'archived'],
            default: "'active'",
            isNullable: false,
          },
          {
            name: 's3Key',
            type: 'text',
            isNullable: false,
          },
          {
            name: 's3Bucket',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'fileSize',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'checksum',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'encryptionKey',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'encryptionAlgorithm',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'changeDescription',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'changeMetadata',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'uploadedById',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'document_versions',
      new TableIndex({
        name: 'IDX_DOC_VERSIONS_DOC_VER',
        columnNames: ['documentId', 'versionNumber'],
      }),
    );

    await queryRunner.createForeignKey(
      'document_versions',
      new TableForeignKey({
        columnNames: ['documentId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'documents',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'document_versions',
      new TableForeignKey({
        columnNames: ['uploadedById'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'document_metadata',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'documentId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'documentVersionId',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'type',
            type: 'enum',
            enum: ['exif', 'ocr', 'form_data', 'custom', 'ai_extraction'],
            isNullable: false,
          },
          {
            name: 'data',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'extractedBy',
            type: 'jsonb',
            default: "'{}'",
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'document_metadata',
      new TableIndex({
        name: 'IDX_DOC_METADATA_DOC_TYPE',
        columnNames: ['documentId', 'type'],
      }),
    );

    await queryRunner.createIndex(
      'document_metadata',
      new TableIndex({
        name: 'IDX_DOC_METADATA_VERSION',
        columnNames: ['documentVersionId'],
      }),
    );

    await queryRunner.createForeignKey(
      'document_metadata',
      new TableForeignKey({
        columnNames: ['documentId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'documents',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'document_metadata',
      new TableForeignKey({
        columnNames: ['documentVersionId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'document_versions',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('document_metadata');
    await queryRunner.dropTable('document_versions');
    await queryRunner.dropTable('documents');
  }
}
