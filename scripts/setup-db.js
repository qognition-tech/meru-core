#!/usr/bin/env node

const { Client } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function setupDatabase() {
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
    const hashedPassword = await bcrypt.hash('admin123', 10);

    // Create admin user
    await client.query(`
      INSERT INTO users (id, "tenantId", email, password, provider, roles, "createdAt")
      VALUES (gen_random_uuid(), $1, 'admin@demo.com', $2, 'local', ARRAY['admin', 'user'], NOW())
    `, [tenantId, hashedPassword]);
    console.log('✅ Created admin user: admin@demo.com (password: admin123)');

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