#!/usr/bin/env node
// Drift check for the server-only dependency manifest.
//
// The published bootstrap/relay image installs ONLY infrastructure/
// server.package.json (not the root package), so if the server source starts
// importing a package that isn't listed there, the image would build fine but
// crash at runtime with "Cannot find module". This guards against that: it
// scans the compiled server output for the external packages it actually
// imports and compares them against the manifest's dependencies.
//
// Usage:
//   npm run build:server            # produce dist-server/ (or this script will)
//   node infrastructure/scripts/check-server-deps.mjs
//
// Exit non-zero if any imported package is missing from the manifest.

import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const distDir = join(repoRoot, 'dist-server');
const manifestPath = join(repoRoot, 'infrastructure', 'server.package.json');

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function fail(msg) {
  console.error(`check-server-deps: ${msg}`);
  process.exit(1);
}

// 1. Ensure the compiled output exists (build it if not).
if (!existsSync(distDir)) {
  console.log('dist-server/ not found — running build:server...');
  try {
    execFileSync('npm', ['run', 'build:server'], { cwd: repoRoot, stdio: 'inherit' });
  } catch {
    fail('build:server failed; cannot scan compiled output');
  }
}

// 2. Collect every .js file under dist-server/.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// 3. Extract bare import specifiers and reduce them to package names. Match only
// real ESM statements, line-anchored, so the words "from"/"import" appearing
// inside ordinary string/object content are never mistaken for imports. tsc's
// ESM output puts each import/export on its own line.
const lineRes = [
  /^\s*(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"\n]+)['"]/, // import/export ... from '...'
  /^\s*import\s*['"]([^'"\n]+)['"]/,                          // bare side-effect import '...'
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/,                     // dynamic import('...')
];
function packageOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null; // relative
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/'); // @scope/name
  return spec.split('/')[0];
}

const imported = new Set();
for (const file of walk(distDir)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    for (const re of lineRes) {
      const m = re.exec(line);
      if (!m) continue;
      const pkg = packageOf(m[1]);
      if (pkg && !builtins.has(pkg)) imported.add(pkg);
    }
  }
}

// 4. Load the server manifest + lock and the root package + lock.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const serverDeps = manifest.dependencies || {};
const serverOverrides = manifest.overrides || {};
const declared = new Set(Object.keys(serverDeps));

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const rootOverrides = rootPkg.overrides || {};
const rootLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
const rootPkgs = rootLock.packages || {};
const rootVersion = (name) => rootPkgs[`node_modules/${name}`]?.version;

let serverLockPkgs = {};
const serverLockPath = join(repoRoot, 'infrastructure', 'server.package-lock.json');
if (existsSync(serverLockPath)) {
  serverLockPkgs = JSON.parse(readFileSync(serverLockPath, 'utf8')).packages || {};
}
const inServerTree = (name) => `node_modules/${name}` in serverLockPkgs;

const errors = [];

console.log(`server imports ${imported.size} external package(s); manifest declares ${declared.size} dependency(ies).`);

// 4a. Import coverage: every imported package must be declared.
const missing = [...imported].filter((p) => !declared.has(p)).sort();
const unused = [...declared].filter((p) => !imported.has(p)).sort();
if (unused.length) {
  console.warn(`\nWARNING: declared but not imported by the server (possible cruft):`);
  for (const p of unused) console.warn(`  - ${p}`);
}
for (const p of missing) {
  errors.push(`imported but not declared in the manifest: ${p}`);
}

// 4b. Version sync: each (exactly pinned) server dep must match the version root
// actually resolves, so the image can't drift behind a root upgrade.
const rangeChar = /[\^~*><= |x]/;
for (const [name, spec] of Object.entries(serverDeps)) {
  const root = rootVersion(name);
  if (!root) {
    errors.push(`server depends on '${name}', which root does not resolve (is it still a real dep?)`);
    continue;
  }
  if (rangeChar.test(spec)) {
    console.warn(`\nWARNING: server dep '${name}' is a range ('${spec}'), not an exact pin; cannot strictly compare to root@${root}.`);
    continue;
  }
  if (spec !== root) {
    errors.push(`version drift: server pins ${name}@${spec} but root resolves ${name}@${root}`);
  }
}

// 4c. Override sync: server overrides must match root's, and any root override
// for a package in the server tree must be replicated (the @libp2p/interface pin
// is what keeps the tree deduped — losing it silently breaks the build).
for (const [name, spec] of Object.entries(serverOverrides)) {
  if (rootOverrides[name] === undefined) {
    errors.push(`server overrides '${name}' but root does not — remove it or align with root`);
  } else if (rootOverrides[name] !== spec) {
    errors.push(`override drift: server overrides ${name}=${spec} but root has ${name}=${rootOverrides[name]}`);
  }
}
for (const [name, spec] of Object.entries(rootOverrides)) {
  if (inServerTree(name) && serverOverrides[name] === undefined) {
    errors.push(`root overrides '${name}'=${spec} and it is in the server tree, but the server manifest does not replicate it`);
  }
}

if (errors.length) {
  console.error(`\nERROR: server dependency manifest is out of sync:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nUpdate infrastructure/server.package.json (pin to root's resolved versions / mirror root overrides) and regenerate infrastructure/server.package-lock.json.`);
  process.exit(1);
}

console.log('\nOK: imports covered, versions pinned to root, overrides mirror root.');
