import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant isolation at the database layer (CLAUDE.md §6.4, north-star "0 isolation
 * incidents ever"). Replaces the three earlier RLS migrations that were stubbed to
 * no-ops because they targeted a snake_case `tenant_id` column that never existed.
 *
 * Three things have to be true for this to isolate anything. Getting any one of
 * them wrong produces the worst possible outcome: policies that exist, look right
 * in `\d+`, and enforce nothing.
 *
 *  1. RLS must be ENABLEd *and* FORCEd. Without FORCE the table owner is exempt,
 *     and migrations/most deployments connect as the owner.
 *
 *  2. The connecting role must not hold BYPASSRLS. This is the trap on managed
 *     Postgres: Neon's `neondb_owner` has `rolbypassrls = true`, so it ignores
 *     every policy no matter what FORCE says. That is why this migration
 *     provisions a separate `meru_app` role and why the application must connect
 *     as that role — see scripts/provision-rls-role.js and DEPLOY.md.
 *
 *  3. Policies must fail CLOSED. `app.current_tenant_id()` returns NULL when the
 *     GUC is unset, and `col = NULL` is NULL (not true), so an unbound connection
 *     reads zero rows rather than everything.
 *
 * Policies are generated from information_schema rather than hand-written per
 * table, because `"tenantId"` is uuid on some tables and varchar on others; a
 * single hand-written expression would either fail to cast or silently disable
 * index usage on half the schema.
 */
export class AddTenantRowLevelSecurity1753500000000 implements MigrationInterface {
  name = 'AddTenantRowLevelSecurity1753500000000';

  /**
   * Tables that carry tenancy through a foreign key instead of their own
   * `tenantId`. Their policy tests visibility of the parent row — and because the
   * parent is itself under RLS, the subquery only finds it when the parent is
   * in-tenant. That makes these policies type-agnostic and self-maintaining.
   */
  private static readonly CHILD_TABLES: ReadonlyArray<
    [child: string, fk: string, parent: string]
  > = [
    ['document_metadata', 'documentId', 'documents'],
    ['document_versions', 'documentId', 'documents'],
    ['form_fields', 'formSchemaId', 'form_schemas'],
    ['invoice_items', 'invoiceId', 'invoices'],
    ['storage_file_versions', 'fileId', 'storage_files'],
    ['task_comments', 'taskId', 'tasks'],
    ['workflow_states', 'workflowId', 'workflows'],
    ['workflow_transitions', 'workflowId', 'workflows'],
    // These two declare no FK constraint, but the column is a real parent
    // reference and the rows carry tenant-derived data (job payload logs,
    // in-flight upload state). Without a policy they are a read-around for
    // anything the parent tables protect.
    ['queue_job_logs', 'jobId', 'queue_jobs'],
    ['storage_multipart_uploads', 'fileId', 'storage_files'],
  ];

  /**
   * Platform-global tables: deliberately NOT tenant-scoped. Config packs and
   * integration adapters are platform artifacts shared by every tenant
   * (CLAUDE.md §4), so isolating them would break the config-injection model.
   */
  private static readonly GLOBAL_TABLES = [
    'config_packs',
    'integration_adapters',
    // Worker registry: process name, heartbeat, concurrency and throughput
    // stats. Infrastructure state with no tenant-derived content, and the
    // queue layer needs to see the whole fleet regardless of who is asking.
    'queue_workers',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Tenant context accessors -------------------------------------
    // STABLE (not IMMUTABLE) so the planner re-reads the GUC per statement but
    // may still cache within one; that is exactly the semantics we want.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS app`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('app.current_tenant_id', true), '')
      $$;
    `);

    // Escape hatch for bootstrap lookups that *establish* identity (resolving a
    // user by email at login, validating an API key) and for audited operator
    // access. Mirrors TenantContext.runAsSystem / runAsGod.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.rls_bypassed() RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT coalesce(current_setting('app.bypass_rls', true) = 'on', false)
      $$;
    `);

    // --- 2. The application role -----------------------------------------
    // NOBYPASSRLS is the whole point. NOLOGIN here; provision-rls-role.js grants
    // LOGIN + password so no credential is ever committed to a migration.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meru_app') THEN
          CREATE ROLE meru_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
        ELSE
          -- Only NOBYPASSRLS is re-asserted here. Managed providers (Neon)
          -- refuse ALTER ROLE ... NOSUPERUSER from a non-superuser connection,
          -- and CREATE ROLE above already defaults to NOSUPERUSER, so trying it
          -- would fail the migration for no gain. The boot-time check in
          -- rls.datasource.ts catches a superuser app role instead.
          ALTER ROLE meru_app NOBYPASSRLS;
        END IF;
      END $$;
    `);

    await queryRunner.query(`GRANT USAGE ON SCHEMA public, app TO meru_app`);
    await queryRunner.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO meru_app`,
    );
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA public TO meru_app
    `);
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO meru_app`,
    );
    // Tables created by later migrations must be reachable without a re-grant.
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meru_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO meru_app
    `);

    // --- 3. Direct tenant-scoped tables ----------------------------------
    // uuid columns compare against a cast GUC so the tenantId index still gets
    // used; varchar columns compare as text. Deriving this from the catalog
    // avoids a 36-way hand-written list drifting out of sync with the entities.
    await queryRunner.query(`
      DO $$
      DECLARE
        r record;
        expr text;
      BEGIN
        FOR r IN
          SELECT c.table_name, c.data_type
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
            AND c.column_name = 'tenantId'
        LOOP
          IF r.data_type = 'uuid' THEN
            expr := format('%I = app.current_tenant_id()::uuid', 'tenantId');
          ELSE
            expr := format('%I = app.current_tenant_id()', 'tenantId');
          END IF;

          EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
          EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
          EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
          EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO public '
            'USING (app.rls_bypassed() OR %s) '
            'WITH CHECK (app.rls_bypassed() OR %s)',
            r.table_name, expr, expr
          );
        END LOOP;
      END $$;
    `);

    // --- 4. The tenants table itself -------------------------------------
    // Its own id *is* the tenant, so it needs a different predicate.
    await queryRunner.query(
      `ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON public.tenants`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON public.tenants FOR ALL TO public
        USING (app.rls_bypassed() OR id = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR id = app.current_tenant_id()::uuid)
    `);

    // --- 5. Child tables (tenancy via FK) --------------------------------
    for (const [
      child,
      fk,
      parent,
    ] of AddTenantRowLevelSecurity1753500000000.CHILD_TABLES) {
      const predicate = `EXISTS (SELECT 1 FROM public.${parent} p WHERE p.id = public.${child}."${fk}")`;
      await queryRunner.query(
        `ALTER TABLE public.${child} ENABLE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE public.${child} FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `DROP POLICY IF EXISTS tenant_isolation ON public.${child}`,
      );
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON public.${child} FOR ALL TO public
          USING (app.rls_bypassed() OR ${predicate})
          WITH CHECK (app.rls_bypassed() OR ${predicate})
      `);
    }

    // --- 6. Platform-global tables ---------------------------------------
    // Readable by every tenant; writes restricted to the owner/migration role.
    for (const table of AddTenantRowLevelSecurity1753500000000.GLOBAL_TABLES) {
      await queryRunner.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `DROP POLICY IF EXISTS platform_global_read ON public.${table}`,
      );
      await queryRunner.query(`
        CREATE POLICY platform_global_read ON public.${table} FOR SELECT TO public
          USING (true)
      `);
      await queryRunner.query(
        `DROP POLICY IF EXISTS platform_global_write ON public.${table}`,
      );
      await queryRunner.query(`
        CREATE POLICY platform_global_write ON public.${table} FOR ALL TO public
          USING (app.rls_bypassed()) WITH CHECK (app.rls_bypassed())
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = await queryRunner.query(`
      SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    `);

    for (const { name } of tables as Array<{ name: string }>) {
      await queryRunner.query(
        `DROP POLICY IF EXISTS tenant_isolation ON public."${name}"`,
      );
      await queryRunner.query(
        `DROP POLICY IF EXISTS platform_global_read ON public."${name}"`,
      );
      await queryRunner.query(
        `DROP POLICY IF EXISTS platform_global_write ON public."${name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE public."${name}" NO FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE public."${name}" DISABLE ROW LEVEL SECURITY`,
      );
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS app.rls_bypassed()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS app.current_tenant_id()`);
    // The role is intentionally left in place: dropping it would break any
    // still-running instance that is connected as meru_app.
  }
}
