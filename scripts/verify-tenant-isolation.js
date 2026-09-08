#!/usr/bin/env node
/**
 * Proves tenant isolation is actually enforced (CLAUDE.md §6.4, north-star
 * metric "tenant data-isolation incidents: 0 ever").
 *
 * This exists because every cheap check for RLS gives a false positive. Policies
 * show up in `\d+`, `relrowsecurity` reads true, the migration reports success —
 * and none of that means a single row is being filtered, because the connecting
 * role may hold BYPASSRLS, or FORCE may be missing, or the GUC may never reach
 * the connection running the query. The only trustworthy check is to connect as
 * the application role and try to read another tenant's rows.
 *
 * Run after `npm run migration:run` and `node scripts/provision-rls-role.js`:
 *   node scripts/verify-tenant-isolation.js
 *
 * Exits non-zero on any isolation failure, so it can gate a deploy.
 */
require('dotenv').config();
const { Client } = require('pg');

const T1 = '00000000-0000-4000-8000-00000000e001';
const T2 = '00000000-0000-4000-8000-00000000e002';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const appUrl = process.env.DATABASE_APP_URL;
  const adminUrl = process.env.DATABASE_URL;

  if (!appUrl) {
    console.error(
      'DATABASE_APP_URL is not set. RLS cannot be verified without the\n' +
        'application role — run: node scripts/provision-rls-role.js',
    );
    process.exit(1);
  }

  const admin = new Client({
    connectionString: adminUrl,
    ssl: { rejectUnauthorized: false },
  });
  const app = new Client({
    connectionString: appUrl,
    ssl: { rejectUnauthorized: false },
  });
  await admin.connect();
  await app.connect();

  try {
    // --- The role itself ---------------------------------------------------
    console.log('\nRole attributes');
    const { rows: roleRows } = await app.query(
      `SELECT current_user AS name, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );
    const role = roleRows[0];
    record(
      'app role does not hold BYPASSRLS',
      role && !role.rolbypassrls,
      `role=${role?.name} bypassrls=${role?.rolbypassrls}`,
    );
    record(
      'app role is not SUPERUSER',
      role && !role.rolsuper,
      `superuser=${role?.rolsuper}`,
    );

    // --- Coverage ----------------------------------------------------------
    console.log('\nPolicy coverage');
    const { rows: uncovered } = await admin.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname <> 'migrations'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY 1
    `);
    record(
      'every public table has RLS enabled AND forced',
      uncovered.length === 0,
      uncovered.length ? `missing: ${uncovered.map((r) => r.relname).join(', ')}` : 'all tables',
    );

    // --- Live isolation on a real table -----------------------------------
    // universal_entities is the polymorphic core table (CLAUDE.md §2 CRM), so
    // it is the most meaningful place to prove filtering.
    console.log('\nLive isolation (universal_entities)');
    await admin.query(`SELECT set_config('app.bypass_rls','on',false)`);
    await admin.query(`DELETE FROM universal_entities WHERE id::text LIKE '00000000-0000-4000-8000-%'`);
    await admin.query(
      `INSERT INTO universal_entities
         (id, "tenantId", type, "firstName", "verticalAttributes", metadata,
          relationships, vertical, environment, "createdAt", "updatedAt")
       VALUES
         ('00000000-0000-4000-8000-00000000a001', $1, 'person', 'tenant-1 row',
          '{}', '{}', '{}', 'immigration', 'test', now(), now()),
         ('00000000-0000-4000-8000-00000000a002', $2, 'person', 'tenant-2 row',
          '{}', '{}', '{}', 'immigration', 'test', now(), now())`,
      [T1, T2],
    );

    const countAs = async (tenant) => {
      await app.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        tenant ?? '',
      ]);
      const { rows } = await app.query(
        `SELECT count(*)::int n FROM universal_entities
         WHERE id::text LIKE '00000000-0000-4000-8000-%'`,
      );
      return rows[0].n;
    };

    record('tenant 1 sees only its own row', (await countAs(T1)) === 1);
    record('tenant 2 sees only its own row', (await countAs(T2)) === 1);
    record(
      'unbound connection sees nothing (fails closed)',
      (await countAs(null)) === 0,
    );

    // --- Writes ------------------------------------------------------------
    console.log('\nWrite containment');
    await app.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T1]);

    let insertBlocked = false;
    try {
      await app.query(
        `INSERT INTO universal_entities
           (id, "tenantId", type, "firstName", "verticalAttributes", metadata,
            relationships, vertical, environment, "createdAt", "updatedAt")
         VALUES ('00000000-0000-4000-8000-00000000a003', $1, 'person', 'forged',
                 '{}', '{}', '{}', 'immigration', 'test', now(), now())`,
        [T2],
      );
    } catch (e) {
      insertBlocked = e.code === '42501';
    }
    record('cannot INSERT a row into another tenant', insertBlocked);

    const upd = await app.query(
      `UPDATE universal_entities SET "tenantId" = $1
       WHERE id = '00000000-0000-4000-8000-00000000a001'`,
      [T2],
    ).catch((e) => ({ rowCount: e.code === '42501' ? 'blocked' : `err ${e.code}` }));
    record(
      'cannot move a row to another tenant via UPDATE',
      upd.rowCount === 'blocked' || upd.rowCount === 0,
      `rowCount=${upd.rowCount}`,
    );

    const del = await app.query(
      `DELETE FROM universal_entities
       WHERE id = '00000000-0000-4000-8000-00000000a002'`,
    );
    record(
      "cannot DELETE another tenant's row",
      del.rowCount === 0,
      `rowCount=${del.rowCount}`,
    );

    // --- Child table inheritance ------------------------------------------
    console.log('\nChild-table inheritance (document_versions -> documents)');
    const { rows: childPolicy } = await admin.query(`
      SELECT count(*)::int n FROM pg_policy
      WHERE polrelid = 'public.document_versions'::regclass
    `);
    record('document_versions carries a policy', childPolicy[0].n > 0);

    // --- Cleanup -----------------------------------------------------------
    await admin.query(
      `DELETE FROM universal_entities WHERE id::text LIKE '00000000-0000-4000-8000-%'`,
    );
  } finally {
    await admin.end().catch(() => {});
    await app.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length) {
    console.error('\nTENANT ISOLATION IS NOT ENFORCED. Do not deploy.');
    process.exit(1);
  }
  console.log('Tenant isolation verified.');
}

main().catch((error) => {
  console.error('Verification error:', error.message);
  process.exit(1);
});
