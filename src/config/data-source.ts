import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

// Resolve entity/migration globs relative to this file so the same data-source
// works whether it's executed as TS (src/config) or compiled JS (dist/src/config).
// This lets migrations run under plain `node` against the compiled output, which
// avoids Node's native TS type-stripping (no enum support in strip-only mode).
const baseDir = path.join(__dirname, '..');

// Neon (and any managed Postgres) hands out a single connection string. Prefer
// it when present; fall back to the discrete vars for local/legacy setups.
const connection = process.env.DATABASE_URL
  ? { url: process.env.DATABASE_URL }
  : {
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };

const AppDataSource = new DataSource({
  type: 'postgres',
  ...connection,
  entities: [path.join(baseDir, '**/*.entity{.ts,.js}')],
  migrations: [path.join(baseDir, 'migrations/*{.ts,.js}')],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  // Managed Postgres requires TLS. The pooler presents a cert that isn't in the
  // local trust store, so don't reject unauthorized.
  ssl: { rejectUnauthorized: false },
});

export default AppDataSource;
