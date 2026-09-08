#!/usr/bin/env node

const { Client } = require('pg');
require('dotenv').config();

async function resetDatabase() {
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

    // Disable foreign key checks temporarily
    await client.query('SET session_replication_role = replica;');

    // Clear all tables in correct order (reverse of dependencies)
    console.log('🗑️  Clearing existing data...');
    await client.query('TRUNCATE TABLE universal_entities CASCADE;');
    await client.query('TRUNCATE TABLE tenant_settings CASCADE;');
    await client.query('TRUNCATE TABLE users CASCADE;');
    await client.query('TRUNCATE TABLE tenants CASCADE;');

    // Re-enable foreign key checks
    await client.query('SET session_replication_role = DEFAULT;');

    console.log('✅ Database cleared successfully');
    client.end();
  } catch (error) {
    console.error('❌ Error clearing database:', error.message);
    client.end();
    process.exit(1);
  }
}

resetDatabase();