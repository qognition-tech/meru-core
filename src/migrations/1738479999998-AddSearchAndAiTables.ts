import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSearchAndAiTables1738479999998 implements MigrationInterface {
  name = 'AddSearchAndAiTables1738479999998';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "searchable_type_enum" AS ENUM('entity', 'document', 'note', 'email')
    `);

    await queryRunner.query(`
      CREATE TYPE "prompt_category_enum" AS ENUM('entity_analysis', 'document_processing', 'workflow_decision', 'data_extraction', 'validation')
    `);

    await queryRunner.query(`
      CREATE TYPE "model_provider_enum" AS ENUM('openai', 'anthropic', 'local')
    `);

    await queryRunner.query(`
      CREATE TABLE "search_index" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "searchableType" "searchable_type_enum" NOT NULL,
        "searchableId" character varying NOT NULL,
        "title" text NOT NULL,
        "content" text NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "vector" tsvector,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_search_index" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_search_index_tenant_type" ON "search_index" ("tenantId", "searchableType")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_search_index_tenant_id" ON "search_index" ("tenantId", "searchableId", "searchableType")
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_prompts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid,
        "category" "prompt_category_enum" NOT NULL,
        "key" character varying NOT NULL,
        "prompt" text NOT NULL,
        "preferredProvider" "model_provider_enum" NOT NULL DEFAULT 'openai',
        "modelConfig" jsonb NOT NULL DEFAULT '{}',
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_prompts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ai_prompts_key" UNIQUE ("key")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ai_prompts_tenant_category" ON "ai_prompts" ("tenantId", "category")
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_embeddings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "vectorId" character varying NOT NULL,
        "type" character varying NOT NULL,
        "resourceId" character varying NOT NULL,
        "vector" jsonb NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_embeddings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ai_embeddings_tenant_vector" ON "ai_embeddings" ("tenantId", "vectorId")
    `);

    await queryRunner.query(`
      INSERT INTO "ai_prompts" ("key", "category", "prompt", "preferredProvider", "modelConfig") VALUES
      ('immigration_entity_analysis', 'entity_analysis', 
       'Analyze the following immigration entity data and provide insights: {{INPUT}}
        Vertical: Immigration
        Provide analysis on:
        1. Data completeness
        2. Potential risks or red flags
        3. Recommended actions
        4. Missing critical information',
       'openai', '{"model": "gpt-4o-mini", "temperature": 0.7}'),

      ('grc_entity_analysis', 'entity_analysis',
       'Analyze the following GRC (Governance, Risk, Compliance) entity: {{INPUT}}
        Vertical: GRC
        Provide analysis on:
        1. Compliance risks
        2. Regulatory requirements
        3. Recommended controls
        4. Risk level assessment',
       'openai', '{"model": "gpt-4o-mini", "temperature": 0.7}'),

      ('labour_entity_analysis', 'entity_analysis',
       'Analyze the following labour/employment entity: {{INPUT}}
        Vertical: Labour
        Provide analysis on:
        1. Employment compliance
        2. Contract status
        3. Regulatory considerations
        4. Recommended next steps',
       'openai', '{"model": "gpt-4o-mini", "temperature": 0.7}'),

      ('document_extraction', 'data_extraction',
       'Extract the following fields from the document: {{INPUT}}
        Required fields: {{FIELDS}}
        Return results as JSON with field names as keys.',
       'openai', '{"model": "gpt-4o-mini", "temperature": 0.3}'),

      ('form_validation', 'validation',
       'Validate the following form data: {{INPUT}}
        Validation rules: {{VALIDATION_RULES}}
        Return validation results as JSON with:
        - valid: boolean
        - errors: array of error messages
        - warnings: array of warning messages',
       'openai', '{"model": "gpt-4o-mini", "temperature": 0.3}')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_embeddings"`);
    await queryRunner.query(`DROP TABLE "ai_prompts"`);
    await queryRunner.query(`DROP TABLE "search_index"`);

    await queryRunner.query(`DROP TYPE "model_provider_enum"`);
    await queryRunner.query(`DROP TYPE "prompt_category_enum"`);
    await queryRunner.query(`DROP TYPE "searchable_type_enum"`);
  }
}
