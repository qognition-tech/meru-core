import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class AddStorageQueueElasticsearch1743930000000 implements MigrationInterface {
  name = 'AddStorageQueueElasticsearch1743930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ==================== STORAGE TABLES ====================

    // Storage Files Table
    await queryRunner.createTable(
      new Table({
        name: 'storage_files',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          {
            name: 'provider',
            type: 'enum',
            enum: ['s3', 'azure', 'gcs', 'local'],
          },
          { name: 'bucket', type: 'varchar' },
          { name: 'key', type: 'varchar' },
          { name: 'originalName', type: 'varchar' },
          { name: 'mimeType', type: 'varchar' },
          { name: 'size', type: 'bigint' },
          { name: 'checksum', type: 'varchar' },
          {
            name: 'status',
            type: 'enum',
            enum: ['uploading', 'active', 'processing', 'archived', 'deleted'],
            default: "'active'",
          },
          {
            name: 'storageClass',
            type: 'enum',
            enum: ['standard', 'infrequent', 'archive', 'glacier'],
            default: "'standard'",
          },
          {
            name: 'access',
            type: 'enum',
            enum: ['public', 'private', 'restricted'],
            default: "'private'",
          },
          { name: 'metadata', type: 'jsonb', default: "'{}'" },
          {
            name: 'tags',
            type: 'text',
            isArray: true,
            default: 'ARRAY[]::text[]',
          },
          { name: 'encryption', type: 'jsonb', isNullable: true },
          { name: 'currentVersionId', type: 'uuid' },
          { name: 'createdById', type: 'uuid' },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
          { name: 'deletedAt', type: 'timestamptz', isNullable: true },
          { name: 'expiresAt', type: 'timestamptz', isNullable: true },
          { name: 'lastAccessedAt', type: 'timestamptz', isNullable: true },
          { name: 'accessCount', type: 'int', default: 0 },
          { name: 'folder', type: 'varchar', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'storage_files',
      new TableIndex({ columnNames: ['tenantId', 'status'] }),
    );
    await queryRunner.createIndex(
      'storage_files',
      new TableIndex({ columnNames: ['tenantId', 'tags'] }),
    );
    await queryRunner.createIndex(
      'storage_files',
      new TableIndex({ columnNames: ['tenantId', 'folder'] }),
    );
    await queryRunner.createIndex(
      'storage_files',
      new TableIndex({ columnNames: ['key'] }),
    );

    // File Versions Table
    await queryRunner.createTable(
      new Table({
        name: 'storage_file_versions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'fileId', type: 'uuid' },
          { name: 'versionNumber', type: 'int' },
          { name: 'size', type: 'bigint' },
          { name: 'checksum', type: 'varchar' },
          { name: 'key', type: 'varchar' },
          { name: 'createdById', type: 'uuid' },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'changeDescription', type: 'text', isNullable: true },
          { name: 'isCurrent', type: 'boolean', default: false },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'storage_file_versions',
      new TableIndex({ columnNames: ['fileId'] }),
    );
    await queryRunner.createForeignKey(
      'storage_file_versions',
      new TableForeignKey({
        columnNames: ['fileId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'storage_files',
        onDelete: 'CASCADE',
      }),
    );

    // Multipart Uploads Table
    await queryRunner.createTable(
      new Table({
        name: 'storage_multipart_uploads',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'uploadId', type: 'varchar' },
          { name: 'fileId', type: 'uuid' },
          { name: 'parts', type: 'jsonb' },
          { name: 'partSize', type: 'bigint' },
          { name: 'totalParts', type: 'int' },
          { name: 'completedParts', type: 'int', default: 0 },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'in_progress', 'completed', 'aborted'],
            default: "'pending'",
          },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'expiresAt', type: 'timestamptz' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'storage_multipart_uploads',
      new TableIndex({ columnNames: ['fileId'] }),
    );
    await queryRunner.createIndex(
      'storage_multipart_uploads',
      new TableIndex({ columnNames: ['status'] }),
    );

    // ==================== QUEUE TABLES ====================

    // Queue Jobs Table
    await queryRunner.createTable(
      new Table({
        name: 'queue_jobs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          { name: 'type', type: 'varchar' },
          {
            name: 'status',
            type: 'enum',
            enum: [
              'pending',
              'processing',
              'completed',
              'failed',
              'retrying',
              'cancelled',
              'scheduled',
            ],
            default: "'pending'",
          },
          {
            name: 'priority',
            type: 'enum',
            enum: ['1', '2', '3', '4', '5'],
            default: "'3'",
          },
          { name: 'data', type: 'jsonb' },
          { name: 'result', type: 'jsonb', isNullable: true },
          { name: 'progress', type: 'jsonb', isNullable: true },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'maxAttempts', type: 'int', default: 3 },
          { name: 'lastError', type: 'text', isNullable: true },
          { name: 'scheduledFor', type: 'timestamptz', isNullable: true },
          { name: 'processedAt', type: 'timestamptz', isNullable: true },
          { name: 'completedAt', type: 'timestamptz', isNullable: true },
          { name: 'failedAt', type: 'timestamptz', isNullable: true },
          { name: 'processedBy', type: 'uuid', isNullable: true },
          { name: 'duration', type: 'int', default: 0 },
          {
            name: 'tags',
            type: 'text',
            isArray: true,
            default: 'ARRAY[]::text[]',
          },
          { name: 'options', type: 'jsonb', default: "'{}'" },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'queue_jobs',
      new TableIndex({ columnNames: ['tenantId', 'status'] }),
    );
    await queryRunner.createIndex(
      'queue_jobs',
      new TableIndex({ columnNames: ['tenantId', 'type'] }),
    );
    await queryRunner.createIndex(
      'queue_jobs',
      new TableIndex({ columnNames: ['status'] }),
    );
    await queryRunner.createIndex(
      'queue_jobs',
      new TableIndex({ columnNames: ['scheduledFor'] }),
    );
    await queryRunner.createIndex(
      'queue_jobs',
      new TableIndex({ columnNames: ['priority', 'createdAt'] }),
    );

    // Queue Job Logs Table
    await queryRunner.createTable(
      new Table({
        name: 'queue_job_logs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'jobId', type: 'uuid' },
          {
            name: 'event',
            type: 'enum',
            enum: ['started', 'progress', 'completed', 'failed', 'retry'],
          },
          { name: 'details', type: 'jsonb', isNullable: true },
          { name: 'message', type: 'text', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'queue_job_logs',
      new TableIndex({ columnNames: ['jobId'] }),
    );
    await queryRunner.createIndex(
      'queue_job_logs',
      new TableIndex({ columnNames: ['createdAt'] }),
    );

    // Queue Workers Table
    await queryRunner.createTable(
      new Table({
        name: 'queue_workers',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'name', type: 'varchar' },
          {
            name: 'status',
            type: 'enum',
            enum: ['active', 'paused', 'stopped'],
            default: "'active'",
          },
          {
            name: 'jobTypes',
            type: 'text',
            isArray: true,
            default: 'ARRAY[]::text[]',
          },
          { name: 'concurrency', type: 'int' },
          { name: 'currentJobs', type: 'jsonb', default: "'{}'" },
          { name: 'lastHeartbeat', type: 'timestamptz', isNullable: true },
          { name: 'stats', type: 'jsonb', default: "'{}'" },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'queue_workers',
      new TableIndex({ columnNames: ['status'] }),
    );

    // Queue Scheduled Jobs Table
    await queryRunner.createTable(
      new Table({
        name: 'queue_scheduled_jobs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'type', type: 'varchar' },
          { name: 'data', type: 'jsonb' },
          { name: 'cronExpression', type: 'varchar' },
          { name: 'nextRun', type: 'timestamptz' },
          { name: 'lastRun', type: 'timestamptz', isNullable: true },
          { name: 'isActive', type: 'boolean', default: true },
          { name: 'runCount', type: 'int', default: 0 },
          { name: 'maxRuns', type: 'int', isNullable: true },
          { name: 'endDate', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'queue_scheduled_jobs',
      new TableIndex({ columnNames: ['tenantId'] }),
    );
    await queryRunner.createIndex(
      'queue_scheduled_jobs',
      new TableIndex({ columnNames: ['type'] }),
    );
    await queryRunner.createIndex(
      'queue_scheduled_jobs',
      new TableIndex({ columnNames: ['nextRun'] }),
    );

    // ==================== ELASTICSEARCH TABLES ====================

    // Elasticsearch Indices Table
    await queryRunner.createTable(
      new Table({
        name: 'elasticsearch_indices',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'entityType', type: 'varchar' },
          { name: 'mapping', type: 'text' },
          { name: 'settings', type: 'jsonb', default: "'{}'" },
          { name: 'documentCount', type: 'int', default: 0 },
          { name: 'sizeInBytes', type: 'bigint', default: 0 },
          { name: 'isActive', type: 'boolean', default: true },
          { name: 'lastIndexedAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'elasticsearch_indices',
      new TableIndex({ columnNames: ['tenantId', 'name'] }),
    );
    await queryRunner.createIndex(
      'elasticsearch_indices',
      new TableIndex({ columnNames: ['entityType'] }),
    );

    // Elasticsearch Documents Table
    await queryRunner.createTable(
      new Table({
        name: 'elasticsearch_documents',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          { name: 'indexId', type: 'uuid' },
          { name: 'entityType', type: 'varchar' },
          { name: 'entityId', type: 'varchar' },
          { name: 'documentId', type: 'varchar' },
          { name: 'content', type: 'text' },
          {
            name: 'tags',
            type: 'text',
            isArray: true,
            default: 'ARRAY[]::text[]',
          },
          { name: 'metadata', type: 'jsonb', default: "'{}'" },
          { name: 'embedding', type: 'float', isArray: true, isNullable: true },
          { name: 'version', type: 'int', default: 0 },
          { name: 'isIndexed', type: 'boolean', default: true },
          { name: 'indexedAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'elasticsearch_documents',
      new TableIndex({ columnNames: ['tenantId', 'indexId'] }),
    );
    await queryRunner.createIndex(
      'elasticsearch_documents',
      new TableIndex({ columnNames: ['entityType', 'entityId'] }),
    );
    await queryRunner.createIndex(
      'elasticsearch_documents',
      new TableIndex({ columnNames: ['indexedAt'] }),
    );

    // Elasticsearch Search Logs Table
    await queryRunner.createTable(
      new Table({
        name: 'elasticsearch_search_logs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'uuid' },
          { name: 'userId', type: 'uuid', isNullable: true },
          { name: 'query', type: 'text' },
          { name: 'indices', type: 'text', isArray: true, isNullable: true },
          { name: 'resultsCount', type: 'int' },
          { name: 'responseTimeMs', type: 'int' },
          { name: 'filters', type: 'jsonb', default: "'{}'" },
          { name: 'hasResults', type: 'boolean', default: false },
          { name: 'clickedResults', type: 'jsonb', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'elasticsearch_search_logs',
      new TableIndex({ columnNames: ['tenantId'] }),
    );
    await queryRunner.createIndex(
      'elasticsearch_search_logs',
      new TableIndex({ columnNames: ['createdAt'] }),
    );
    await queryRunner.createIndex(
      'elasticsearch_search_logs',
      new TableIndex({ columnNames: ['query'] }),
    );

    // ==================== ENABLE RLS ====================
    await queryRunner.query(`
      ALTER TABLE storage_files ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON storage_files USING (tenantId = current_setting('app.current_tenant')::UUID);
      
      ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON queue_jobs USING (tenantId = current_setting('app.current_tenant')::UUID);
      
      ALTER TABLE queue_scheduled_jobs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON queue_scheduled_jobs USING (tenantId = current_setting('app.current_tenant')::UUID);
      
      ALTER TABLE elasticsearch_indices ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON elasticsearch_indices USING (tenantId = current_setting('app.current_tenant')::UUID);
      
      ALTER TABLE elasticsearch_documents ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON elasticsearch_documents USING (tenantId = current_setting('app.current_tenant')::UUID);
      
      ALTER TABLE elasticsearch_search_logs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON elasticsearch_search_logs USING (tenantId = current_setting('app.current_tenant')::UUID);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop RLS policies
    await queryRunner.query(`
      DROP POLICY IF EXISTS tenant_isolation ON storage_files;
      DROP POLICY IF EXISTS tenant_isolation ON queue_jobs;
      DROP POLICY IF EXISTS tenant_isolation ON queue_scheduled_jobs;
      DROP POLICY IF EXISTS tenant_isolation ON elasticsearch_indices;
      DROP POLICY IF EXISTS tenant_isolation ON elasticsearch_documents;
      DROP POLICY IF EXISTS tenant_isolation ON elasticsearch_search_logs;
      
      ALTER TABLE storage_files DISABLE ROW LEVEL SECURITY;
      ALTER TABLE queue_jobs DISABLE ROW LEVEL SECURITY;
      ALTER TABLE queue_scheduled_jobs DISABLE ROW LEVEL SECURITY;
      ALTER TABLE elasticsearch_indices DISABLE ROW LEVEL SECURITY;
      ALTER TABLE elasticsearch_documents DISABLE ROW LEVEL SECURITY;
      ALTER TABLE elasticsearch_search_logs DISABLE ROW LEVEL SECURITY;
    `);

    // Drop tables in reverse order
    await queryRunner.dropTable('elasticsearch_search_logs');
    await queryRunner.dropTable('elasticsearch_documents');
    await queryRunner.dropTable('elasticsearch_indices');
    await queryRunner.dropTable('queue_scheduled_jobs');
    await queryRunner.dropTable('queue_workers');
    await queryRunner.dropTable('queue_job_logs');
    await queryRunner.dropTable('queue_jobs');
    await queryRunner.dropTable('storage_multipart_uploads');
    await queryRunner.dropTable('storage_file_versions');
    await queryRunner.dropTable('storage_files');
  }
}
