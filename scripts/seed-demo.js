// Seeds one demo tenant + four demo users so the front-end portals can log in.
// Idempotent: safe to run repeatedly — existing rows are updated, not duplicated.
//
// Run from repo root AFTER `npm run build` (and after scripts/sync-schema.js has
// materialized the schema):   node scripts/seed-demo.js
//
// Connection: prefers DATABASE_URL (Neon / Supabase pooler connection string),
// otherwise falls back to the discrete DATABASE_* vars.
require('dotenv').config();
const path = require('path');
const { DataSource } = require('typeorm');
const bcrypt = require('bcrypt');

const DIST = path.join(__dirname, '..', 'dist', 'src');

function requireDist(rel) {
  try {
    return require(path.join(DIST, rel));
  } catch (e) {
    throw new Error(
      `Could not load ${rel} from dist/ — run \`npm run build\` first. (${e.message})`,
    );
  }
}

// Entity classes + enums come from the compiled output so the values below are
// always the real enum members, never hand-copied strings.
const { Tenant, VerticalType, TenantStatus, TenantPlan } = requireDist(
  'iam/entities/tenant.entity',
);
const { User, AuthProvider, UserStatus } = requireDist(
  'iam/entities/user.entity',
);
const { Role } = requireDist('iam/entities/role.entity');

// ─── Config ────────────────────────────────────────────────────────────

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo123';
const BCRYPT_ROUNDS = 10; // must match iam.service.ts → bcrypt.hash(dto.password, 10)

const TENANT = {
  slug: 'demo',
  name: 'Demo Firm',
  vertical: VerticalType.IMMIGRATION,
  status: TenantStatus.ACTIVE,
  plan: TenantPlan.ENTERPRISE,
  settings: {
    branding: { colors: { primary: '#0F172A', secondary: '#6366F1' } },
    limits: {
      users: 100,
      storageGB: 100,
      documents: 100000,
      apiCallsPerMonth: 1000000,
    },
    features: {
      aiAnalysis: true,
      advancedSearch: true,
      customWorkflows: true,
      sso: false,
      apiAccess: true,
    },
    notifications: { emailFromName: 'Demo Firm' },
  },
  metadata: { industry: 'immigration', companySize: '11-50', source: 'seed-demo' },
};

// Role names match iam.service.ts → resolvePrimaryRole() precedence list:
//   ['platform_admin', 'firm_admin', 'staff', 'client']
const ROLES = [
  {
    name: 'platform_admin',
    description: 'Meru platform operator — God View, cross-tenant administration',
    permissions: ['*'],
  },
  {
    name: 'firm_admin',
    description: 'Tenant administrator — full access within the tenant',
    permissions: [
      'tenant:read',
      'tenant:write',
      'user:read',
      'user:write',
      'case:read',
      'case:write',
      'document:read',
      'document:write',
      'billing:read',
      'report:read',
    ],
  },
  {
    name: 'staff',
    description: 'Case worker — day-to-day case and document handling',
    permissions: [
      'case:read',
      'case:write',
      'document:read',
      'document:write',
      'task:read',
      'task:write',
      'user:read',
    ],
  },
  {
    name: 'client',
    description: 'End client — read-only access to their own cases and documents',
    permissions: ['case:read:own', 'document:read:own', 'document:write:own'],
  },
];

const USERS = [
  { email: 'admin@demo.com', firstName: 'Ada', lastName: 'Admin', role: 'firm_admin' },
  { email: 'staff@demo.com', firstName: 'Sam', lastName: 'Staff', role: 'staff' },
  { email: 'client@demo.com', firstName: 'Cleo', lastName: 'Client', role: 'client' },
  {
    email: 'platform@demo.com',
    firstName: 'Pat',
    lastName: 'Platform',
    role: 'platform_admin',
  },
];

// ─── DataSource ────────────────────────────────────────────────────────

const connection = process.env.DATABASE_URL
  ? { url: process.env.DATABASE_URL }
  : {
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };

const ds = new DataSource({
  type: 'postgres',
  ...connection,
  entities: [path.join(__dirname, '..', 'dist', 'src', '**', '*.entity.js')],
  synchronize: false,
  logging: ['error'],
  ssl: { rejectUnauthorized: false },
});

// ─── Seed ──────────────────────────────────────────────────────────────

(async () => {
  await ds.initialize();

  const tenantRepo = ds.getRepository(Tenant);
  const roleRepo = ds.getRepository(Role);
  const userRepo = ds.getRepository(User);

  // 1. Tenant (match on unique slug)
  let tenant = await tenantRepo.findOne({ where: { slug: TENANT.slug } });
  let tenantAction;
  if (tenant) {
    tenantRepo.merge(tenant, TENANT);
    tenant.deletedAt = null;
    tenant = await tenantRepo.save(tenant);
    tenantAction = 'updated';
  } else {
    tenant = await tenantRepo.save(tenantRepo.create(TENANT));
    tenantAction = 'created';
  }
  console.log(`Tenant ${tenantAction}: ${tenant.slug} (${tenant.id})`);

  // 2. Roles (match on tenantId + name)
  for (const def of ROLES) {
    const existing = await roleRepo.findOne({
      where: { tenantId: tenant.id, name: def.name },
    });
    if (existing) {
      existing.description = def.description;
      existing.permissions = def.permissions;
      await roleRepo.save(existing);
      console.log(`  role updated: ${def.name}`);
    } else {
      await roleRepo.save(
        roleRepo.create({
          tenantId: tenant.id,
          name: def.name,
          description: def.description,
          permissions: def.permissions,
          // NOTE: left false deliberately. iam.service.validateUser() grants EVERY
          // isSystem role in the tenant to EVERY user of that tenant, so flipping
          // this to true would hand platform_admin to client@demo.com. Per-user
          // roles are stored on users.roles below.
          isSystem: false,
        }),
      );
      console.log(`  role created: ${def.name}`);
    }
  }

  // 3. Users (match on unique email). Password is always re-hashed so the demo
  //    credentials keep working even if someone changed them.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);

  for (const def of USERS) {
    const fields = {
      tenantId: tenant.id,
      email: def.email,
      password: passwordHash,
      firstName: def.firstName,
      lastName: def.lastName,
      provider: AuthProvider.LOCAL, // users.provider column, enum value 'local'
      status: UserStatus.ACTIVE,
      mfaEnabled: false,
      roles: [def.role],
      preferences: { theme: 'dark', locale: 'en' },
      attributes: {
        firstName: def.firstName,
        lastName: def.lastName,
        seed: 'demo',
      },
      deletedAt: null,
    };

    const existing = await userRepo.findOne({ where: { email: def.email } });
    if (existing) {
      // update() rather than save() so the `select: false` password column is
      // written without having to re-select it.
      await userRepo.update(existing.id, fields);
      console.log(`  user updated: ${def.email} → ${def.role}`);
    } else {
      await userRepo.save(userRepo.create(fields));
      console.log(`  user created: ${def.email} → ${def.role}`);
    }
  }

  // 4. Summary
  const seeded = await userRepo.find({
    where: { tenantId: tenant.id },
    order: { email: 'ASC' },
  });

  console.log('\n─────────────────────────────────────────────');
  console.log('SEED OK');
  console.log(`  tenant id   : ${tenant.id}`);
  console.log(`  tenant slug : ${tenant.slug}`);
  console.log(`  tenant name : ${tenant.name} (${tenant.vertical})`);
  console.log(`  password    : ${DEMO_PASSWORD}`);
  console.log('  users:');
  for (const u of seeded) {
    console.log(
      `    ${u.email.padEnd(20)} ${(u.roles || []).join(',').padEnd(16)} ${u.id}`,
    );
  }
  console.log('─────────────────────────────────────────────');

  await ds.destroy();
})().catch(async (e) => {
  console.error('SEED FAILED:', e.message);
  if (ds.isInitialized) {
    await ds.destroy().catch(() => {});
  }
  process.exit(1);
});
