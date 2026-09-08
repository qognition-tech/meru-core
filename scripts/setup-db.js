#!/usr/bin/env node

const { Client } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

/**
 * DEV ONLY, and now it refuses to prove it.
 *
 * This script TRUNCATEs `universal_entities`, `tenant_settings`, `users` and
 * `tenants` whenever any tenant exists, with `session_replication_role =
 * replica` set first — which suppresses triggers as well as foreign keys, so it
 * would step straight past the append-only guard on `audit_logs` too. It took
 * its connection from the same generic `DATABASE_*` variables every other tool
 * reads, and seeded a fixed `admin@demo.com` / `admin123`. Nothing stopped it
 * being pointed at production; the only protection was that nobody had.
 *
 * Three gates now, all fail-closed:
 *   1. `SETUP_DB_DESTRUCTIVE_OK` must equal the exact database name being wiped,
 *      so the operator has to type the target rather than set a boolean.
 *   2. A non-local host additionally requires `SETUP_DB_ALLOW_REMOTE=true`.
 *   3. The seeded admin's email and password come from env with no fallback.
 */
function requireEnv(name, why) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n${name} is not set — ${why}\nRefusing to run.\n`);
    process.exit(1);
  }
  return v;
}

function assertDestructionAuthorised(dbName, host) {
  const confirm = process.env.SETUP_DB_DESTRUCTIVE_OK;
  if (confirm !== dbName) {
    console.error(
      `\nThis script TRUNCATEs tenants, users, universal_entities and ` +
        `tenant_settings.\nTo run it against "${dbName}", set ` +
        `SETUP_DB_DESTRUCTIVE_OK="${dbName}".\nRefusing to run.\n`,
    );
    process.exit(1);
  }
  const local = !host || host === 'localhost' || host === '127.0.0.1';
  if (!local && process.env.SETUP_DB_ALLOW_REMOTE !== 'true') {
    console.error(
      `\nHost "${host}" is not local. This wipes four tables.\n` +
        `Set SETUP_DB_ALLOW_REMOTE=true only if you are certain.\n` +
        `Refusing to run.\n`,
    );
    process.exit(1);
  }
}

async function setupDatabase() {
  const adminEmail = requireEnv(
    'SETUP_ADMIN_EMAIL',
    'the seeded admin account must not have a committed address',
  );
  const adminPassword = requireEnv(
    'SETUP_ADMIN_PASSWORD',
    'the seeded admin account must not have a committed password',
  );
  assertDestructionAuthorised(
    process.env.DATABASE_NAME,
    process.env.DATABASE_HOST,
  );

  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT || 5432,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  try {
    console.log('🔄 Connecting to database...');
    await client.connect();
    console.log('✅ Database connected successfully!');

    // Check if data already exists
    const tenantCheck = await client.query('SELECT COUNT(*) as count FROM tenants');
    if (parseInt(tenantCheck.rows[0].count) > 0) {
      console.log('ℹ️  Database already has data. Clearing and re-populating...');
      // Clear existing data
      await client.query('SET session_replication_role = replica;');
      await client.query('TRUNCATE TABLE universal_entities CASCADE;');
      await client.query('TRUNCATE TABLE tenant_settings CASCADE;');
      await client.query('TRUNCATE TABLE users CASCADE;');
      await client.query('TRUNCATE TABLE tenants CASCADE;');
      await client.query('SET session_replication_role = DEFAULT;');
    }

    console.log('🔄 Setting up initial data...');

    // Create a sample tenant
    const tenantResult = await client.query(`
      INSERT INTO tenants (id, slug, name, vertical, "createdAt")
      VALUES (gen_random_uuid(), 'demo-company', 'Demo Company', 'fintech', NOW())
      RETURNING id
    `);
    const tenantId = tenantResult.rows[0].id;
    console.log(`✅ Created tenant: ${tenantId}`);

    // Hash password for admin user
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    // Create admin user
    await client.query(`
      INSERT INTO users (id, "tenantId", email, password, provider, roles, "createdAt")
      VALUES (gen_random_uuid(), $1, $3, $2, 'local', ARRAY['firm_admin'], NOW())
    `, [tenantId, hashedPassword, adminEmail]);
    // `firm_admin`, not the previous `['admin','user']`. Neither of those is a
    // value in `PlatformRole`, and that enum's own comment records what happens:
    // `PolicyGuard` string-matches, so an unrecognised role is a silent 403 on
    // every guarded route. This script was seeding an account that could not
    // actually use the product.
    console.log(`✅ Created admin user: ${adminEmail} (password from SETUP_ADMIN_PASSWORD)`);

    // Create tenant settings
    await client.query(`
      INSERT INTO tenant_settings (id, "tenantId", config, "updatedAt")
      VALUES (gen_random_uuid(), $1, $2, NOW())
    `, [tenantId, JSON.stringify({
      vertical: 'fintech',
      entityName: 'Contact',
      fields: [
        { key: 'department', type: 'text', label: 'Department', required: false },
        { key: 'clearanceLevel', type: 'select', label: 'Clearance Level', required: false, options: ['standard', 'confidential', 'secret'] }
      ]
    })]);
    console.log('✅ Created tenant settings');

    // Create sample CRM entity
    await client.query(`
      INSERT INTO universal_entities (id, "tenantId", type, "firstName", "lastName", email, "phoneNumber", "verticalAttributes", "createdAt")
      VALUES (gen_random_uuid(), $1, 'person', 'John', 'Doe', 'john.doe@example.com', '+1234567890', $2, NOW())
    `, [tenantId, JSON.stringify({ department: 'sales', clearanceLevel: 'standard' })]);
    console.log('✅ Created sample CRM entity');

    client.end();
    console.log('\n🎉 Database setup complete!');
    console.log('\n📋 Login Credentials:');
    console.log('Email: admin@demo.com');
    console.log('Password: admin123');
    console.log('\n🚀 You can now start the application with: pnpm run start:dev');
    console.log('📖 API Documentation: http://localhost:3000/api');

  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    client.end();
    process.exit(1);
  }
}

setupDatabase();