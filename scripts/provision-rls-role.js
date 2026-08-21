#!/usr/bin/env node
/**
 * Provisions the login credentials for the `meru_app` database role.
 *
 * Why a second role exists at all: row-level security is silently inert for any
 * role holding BYPASSRLS, and that is the default for managed-Postgres owner
 * accounts — on Neon, that is `neondb_owner`, which this project runs on. Running
 * the application as the owner means every tenant policy is decoration. So:
 *
 *   - migrations / DDL  -> owner role      (DATABASE_URL)
 *   - application runtime -> meru_app      (DATABASE_APP_URL)
 *
 * The role itself is created by the AddTenantRowLevelSecurity migration; this
 * script only attaches a password and LOGIN, so no credential lives in a
 * migration file or in git.
 *
 * Usage:
 *   node scripts/provision-rls-role.js                 # generates a password
 *   MERU_APP_PASSWORD=... node scripts/provision-rls-role.js
 *
 * Prints the connection string to put in DATABASE_APP_URL.
 */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

/**
 * Managed providers reject weak passwords at the control plane (Neon returns a
 * 400 for anything lacking mixed case / digits / symbols), so guarantee at least
 * one character from each class rather than hoping random bytes cover them.
 * Symbols are restricted to ones that survive a URL-encoded connection string.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '-_.~';
  const all = upper + lower + digits + symbols;

  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 32) chars.push(pick(all));

  // Fisher-Yates so the guaranteed characters are not always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function main() {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error('DATABASE_URL is not set (needs the owner/admin connection).');
    process.exit(1);
  }

  const password = process.env.MERU_APP_PASSWORD || generatePassword();

  const client = new Client({
    connectionString: adminUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'meru_app'`,
    );
    if (rows.length === 0) {
      console.error(
        'Role meru_app does not exist. Run the migrations first:\n' +
          '  npm run migration:run',
      );
      process.exit(1);
    }

    // Quoted literal rather than a bind parameter: ALTER ROLE does not accept
    // parameters. The password is generated locally, never user-supplied.
    const quoted = password.replace(/'/g, "''");
    await client.query(`ALTER ROLE meru_app LOGIN PASSWORD '${quoted}'`);

    // Re-assert the attribute that makes the whole scheme work, in case the role
    // was created by hand or altered since the migration ran. NOSUPERUSER is not
    // included: Neon rejects it from a non-superuser connection. The verify step
    // below still refuses to proceed if the role turns out to be a superuser.
    await client.query(`ALTER ROLE meru_app NOBYPASSRLS`);

    const check = await client.query(
      `SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname='meru_app'`,
    );
    const attrs = check.rows[0];
    if (attrs.rolbypassrls || attrs.rolsuper) {
      console.error(
        'REFUSING: meru_app still has BYPASSRLS/SUPERUSER — RLS would not be enforced.',
      );
      process.exit(1);
    }

    const appUrl = new URL(adminUrl);
    appUrl.username = 'meru_app';
    appUrl.password = password;

    console.log('\nmeru_app provisioned.');
    console.log(`  can login : ${attrs.rolcanlogin}`);
    console.log(`  bypassrls : ${attrs.rolbypassrls}  (must be false)`);

    const line = `DATABASE_APP_URL=${appUrl.toString()}`;

    if (process.argv.includes('--write-env')) {
      const envPath = path.join(__dirname, '..', '.env');
      const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      const next = current.match(/^DATABASE_APP_URL=.*$/m)
        ? current.replace(/^DATABASE_APP_URL=.*$/m, line)
        : `${current.replace(/\s*$/, '')}\n\n# Runtime role for RLS enforcement (see scripts/provision-rls-role.js)\n${line}\n`;
      fs.writeFileSync(envPath, next);
      console.log(`\n  wrote DATABASE_APP_URL to ${envPath}`);
      console.log('  (password not echoed — read it from .env)\n');
    } else {
      console.log('\nAdd this to your environment:\n');
      console.log(`${line}\n`);
      console.log('Or re-run with --write-env to update .env automatically.\n');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Provisioning failed:', error.message);
  process.exit(1);
});
