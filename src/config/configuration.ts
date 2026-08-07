import * as Joi from 'joi';

/**
 * Every entry below is `.empty('')`, which converts an empty string to
 * undefined so the declared `.default()` applies.
 *
 * This is not cosmetic. Joi's `.default()` only fires for *undefined*; an env
 * var that exists but is empty is a defined empty string and fails
 * validation ("is not allowed to be empty", or the `.valid()` list for enums).
 * ConfigModule throws that at startup, Nest never finishes booting, and every
 * route — including /health — answers 500. A deployment platform writing an
 * empty value for an optional variable should degrade to its default, not
 * take the whole API down.
 *
 * JWT_SECRET deliberately keeps failing on empty: booting with no signing
 * secret is worse than not booting.
 */
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().empty('')
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().empty('').default(3000),
  VERTICAL: Joi.string().empty('')
    .valid('core', 'immigration', 'grc', 'labour', 'fintech', 'legal')
    .default('core'),

  // CORS
  CORS_ALLOWED_ORIGINS: Joi.string().empty('').default(
    'http://localhost:3000,http://localhost:3001,http://localhost:3002',
  ),

  // Rate Limiting
  RATE_LIMIT_TTL_MS: Joi.number().empty('').default(60000),
  RATE_LIMIT_MAX_GLOBAL: Joi.number().empty('').default(100),
  RATE_LIMIT_MAX_IMMIGRATION: Joi.number().empty('').default(100),
  RATE_LIMIT_MAX_BANKING: Joi.number().empty('').default(50),

  // AWS Secrets Manager
  AWS_REGION: Joi.string().empty('').default('ap-south-1'),
  AWS_RDS_SECRET_NAME: Joi.string().empty('').optional().allow(''),

  // Database — DATABASE_URL (Neon) takes precedence over the discrete vars.
  DATABASE_URL: Joi.string().empty('').optional(),
  DATABASE_HOST: Joi.string().empty('').optional(),
  DATABASE_PORT: Joi.number().empty('').default(5432),
  DATABASE_USERNAME: Joi.string().empty('').optional(),
  DATABASE_PASSWORD: Joi.string().empty('').optional(),
  DATABASE_NAME: Joi.string().empty('').optional(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().empty('').default('1h'),
  CRON_SECRET: Joi.string().empty('').optional(),

  // Cache (Redis URL optional, falls back to memory)
  REDIS_HOST: Joi.string().empty('').optional(),
  REDIS_PORT: Joi.number().empty('').optional(),

  // AWS S3
  AWS_ACCESS_KEY_ID: Joi.string().empty('').optional().allow(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().empty('').optional().allow(''),
  AWS_S3_BUCKET: Joi.string().empty('').default('meru-documents'),

  // Documents
  DOCUMENT_ENCRYPTION_KEY: Joi.string().empty('').default(
    'default-encryption-key-32-chars!',
  ),
  MAX_FILE_SIZE: Joi.number().empty('').default(52428800),
});

export const configuration = () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  vertical: process.env.VERTICAL || 'core',
  database: {
    // Runtime connects as the non-BYPASSRLS `meru_app` role so tenant policies
    // are actually enforced; DATABASE_URL (owner) is reserved for migrations and
    // is only used at runtime as a fallback when the app role is not provisioned.
    // See scripts/provision-rls-role.js.
    url: process.env.DATABASE_APP_URL || process.env.DATABASE_URL,
    migrationUrl: process.env.DATABASE_URL,
    // Per-vertical databases (three-DB split, MASTER_GAP_ANALYSIS §2 P1).
    // Unset ⇒ that vertical shares the default (control-plane) database, so
    // the split can roll out one environment at a time without downtime.
    govxUrl: process.env.GOVX_DB_APP_URL || process.env.GOVX_DB_URL,
    immistackUrl:
      process.env.IMMISTACK_DB_APP_URL || process.env.IMMISTACK_DB_URL,
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    name: process.env.DATABASE_NAME,
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    rdsSecretName: process.env.AWS_RDS_SECRET_NAME,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    s3Bucket: process.env.AWS_S3_BUCKET || 'meru-documents',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRATION,
  },
  cache: {
    store: process.env.REDIS_HOST ? 'redis' : 'memory',
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  documents: {
    encryptionKey:
      process.env.DOCUMENT_ENCRYPTION_KEY || 'default-encryption-key-32-chars!',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  },
});
