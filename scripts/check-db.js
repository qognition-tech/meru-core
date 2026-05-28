#!/usr/bin/env node

const { Client } = require('pg');
require('dotenv').config();

async function checkData() {
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
    console.log('✅ Connected to database');

    // Check tenants
    const tenants = await client.query('SELECT id, slug, name, vertical FROM tenants');
    console.log(`\n📊 Tenants (${tenants.rows.length}):`);
    tenants.rows.forEach(tenant => console.log(`  - ${tenant.name} (${tenant.slug}) - ${tenant.vertical}`));

    // Check users
    const users = await client.query('SELECT email, "tenantId", roles FROM users');
    console.log(`\n👥 Users (${users.rows.length}):`);
    users.rows.forEach(user => console.log(`  - ${user.email} - Roles: ${user.roles.join(', ')}`));

    // Check tenant settings
    const settings = await client.query('SELECT "tenantId", "verticalConfig" FROM tenant_settings');
    console.log(`\n⚙️  Tenant Settings (${settings.rows.length}):`);
    settings.rows.forEach(setting => console.log(`  - Tenant: ${setting.tenantId} - Config: ${JSON.stringify(setting.verticalConfig, null, 2)}`));

    // Check CRM entities
    const entities = await client.query('SELECT "tenantId", type, "firstName", "lastName", email FROM universal_entities');
    console.log(`\n🏢 CRM Entities (${entities.rows.length}):`);
    entities.rows.forEach(entity => console.log(`  - ${entity.firstName} ${entity.lastName} (${entity.email}) - ${entity.type}`));

    client.end();
  } catch (error) {
    console.error('❌ Error checking data:', error.message);
    client.end();
    process.exit(1);
  }
}

checkData();