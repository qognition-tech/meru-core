#!/usr/bin/env node
/**
 * Fails if any production dependency can only be loaded as an ES module.
 *
 * Why this exists: the Vercel serverless runtime loads api/index.js as
 * CommonJS through its own loader, which — unlike Node 22+ — cannot require()
 * an ES module at all. An ESM-only package anywhere in the require graph
 * therefore crashes the function on *every* request with ERR_REQUIRE_ESM,
 * while working perfectly on a local Node 24 that supports require(esm).
 *
 * That gap has now burned two deploys (`uuid`, then otplib v13 →
 * @scure/base). `npm test` will not catch it and neither will `npm run build`.
 * This will.
 *
 * Usage:  node scripts/check-cjs-deps.js
 * Exits 1 and prints the dependency chain for anything unloadable.
 */
const fs = require('fs');
const path = require('path');

// Packages that are ESM-only but are never reached from the request path.
// Each entry must say why it is safe, or it does not belong here.
const ALLOWED = new Map([
  [
    'file-type',
    '@nestjs/common lazy-loads this only inside FileTypeValidator (ParseFilePipe); nothing here uses it',
  ],
  ['@tokenizer/inflate', 'transitive dep of file-type'],
  ['token-types', 'transitive dep of file-type'],
  ['@borewit/text-codec', 'transitive dep of file-type'],
  ['strtok3', 'transitive dep of file-type'],
  ['uint8array-extras', 'transitive dep of file-type'],
  ['string-width', 'typeorm CLI only (glob → jackspeak → cliui), not the runtime'],
  ['strip-ansi', 'typeorm CLI only'],
  ['ansi-regex', 'typeorm CLI only'],
  ['wrap-ansi', 'typeorm CLI only'],
  ['ansi-styles', 'typeorm CLI only'],
]);

function resolvePackageJson(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Can a CommonJS caller load this package? */
function isRequireable(pkg) {
  if (pkg.type !== 'module') return true;
  // An "exports" map with a `require` condition provides a CJS build.
  if (pkg.exports && JSON.stringify(pkg.exports).includes('"require"')) {
    return true;
  }
  // Explicit .cjs entry point.
  return Boolean(pkg.main && pkg.main.endsWith('.cjs'));
}

const visited = new Set();
const offenders = new Map();

function walk(name, fromDir, chain) {
  const pkgPath = resolvePackageJson(name, fromDir);
  if (!pkgPath || visited.has(pkgPath)) return;
  visited.add(pkgPath);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return;
  }

  if (!isRequireable(pkg) && !offenders.has(name)) {
    offenders.set(name, [...chain, name].join(' → '));
  }

  const base = path.dirname(pkgPath);
  for (const dep of Object.keys(pkg.dependencies || {})) {
    walk(dep, base, [...chain, name]);
  }
}

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const dep of Object.keys(root.dependencies || {})) {
  walk(dep, process.cwd(), []);
}

const blocking = [...offenders].filter(([name]) => !ALLOWED.has(name));

console.log(`Scanned ${visited.size} packages in the production graph.`);

for (const [name] of offenders) {
  if (ALLOWED.has(name)) {
    console.log(`  allowed  ${name} — ${ALLOWED.get(name)}`);
  }
}

if (blocking.length === 0) {
  console.log('\nNo blocking ESM-only dependencies. Safe to deploy.');
  process.exit(0);
}

console.error('\nESM-only packages in the require graph:\n');
for (const [name, chain] of blocking) {
  console.error(`  ${name}\n      via ${chain}`);
}
console.error(
  '\nThe Vercel serverless loader cannot require() these, so the function\n' +
    'will crash with ERR_REQUIRE_ESM on every request. Replace the package\n' +
    'with a CommonJS-compatible version, or add it to ALLOWED in this script\n' +
    'with a note explaining why it is never reached at runtime.',
);
process.exit(1);
