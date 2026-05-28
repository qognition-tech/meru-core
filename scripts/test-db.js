#!/usr/bin/env node

const { Client } = require('pg');
require('dotenv').config();

async function testConnection() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT || 5432,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('✅ Database connected successfully!');

    const result = await client.query('SELECT version()');
    console.log('PostgreSQL version:', result.rows[0].version);

    // Check if tables exist
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log('\nExisting tables:');
    tables.rows.forEach(row => {
      console.log(`- ${row.table_name}`);
    });

    client.end();
    console.log('\n✅ Database setup complete!');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    client.end();
    process.exit(1);
  }
}

testConnection();