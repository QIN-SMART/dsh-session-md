#!/usr/bin/env node
/**
 * Composition check: does the installed web profile actually mount this plugin?
 *
 * The plugin's own tests prove the Cordis lifecycle; this one proves the
 * *bundle* is wired. It copies the real profile into a throwaway `DSH_HOME`
 * (node_modules symlinked, never copied), composes the profile tree there with
 * `dsh --dump-config`, and asserts that this package contributes a row. The
 * real `~/.dsh` is only ever read.
 *
 *   node scripts/compose-check.mjs                  # default profile: web
 *   PROFILE=tui node scripts/compose-check.mjs
 *
 * Skips (exit 0) when `dsh` is not on PATH or the profile does not exist.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const profileName = process.env.PROFILE ?? 'web';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profileName);

if (!existsSync(profileDir)) {
  console.log(`skip: no profile at ${profileDir}`);
  process.exit(0);
}
const FINDER = process.platform === 'win32' ? 'where' : 'which';
try {
  execFileSync(FINDER, ['dsh'], { stdio: 'ignore' });
} catch {
  console.log('skip: dsh is not on PATH');
  process.exit(0);
}

const scratch = join(tmpdir(), `dsh-session-md-compose-${process.pid}`);
const scratchProfiles = join(scratch, 'profiles');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratchProfiles, { recursive: true });

/** Copy a profile without its (large) node_modules; link that instead. */
function stageProfile(from, to, linkNodeModules) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });
  if (linkNodeModules && existsSync(join(from, 'node_modules'))) {
    // A Windows directory symlink needs Developer Mode or admin; a junction is
    // the unprivileged equivalent and resolves the same way for module lookup.
    symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'),
      process.platform === 'win32' ? 'junction' : undefined);
  }
}

stageProfile(profileDir, join(scratchProfiles, profileName), true);
const shared = join(dshHome, 'profiles', 'node_modules');
if (existsSync(shared)) {
  symlinkSync(shared, join(scratchProfiles, 'node_modules'), process.platform === 'win32' ? 'junction' : undefined);
}

let dump;
try {
  dump = execFileSync('dsh', ['--profile', profileName, '--dump-config'], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: scratch },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const rows = dump.split('\n').filter((line, index, lines) => (
  line.trim() === '- id: session-md' && lines[index + 1]?.trim() === 'name: dsh-session-md'
));
const skipped = dump.split('\n').filter((line) => line.includes('dsh-session-md') && /incompatible|skipping/.test(line));
const duplicates = rows.length;

assert.ok(duplicates >= 1, 'the composed profile does not contain the session-md row');
assert.equal(skipped.length, 0, `the profile refuses to load the bundle: ${skipped.join('; ')}`);

// Every shipped file is referenced by the manifest so `dsh plugin add` ships it.
const manifest = JSON.parse(execFileSync('cat', ['package.json'], { encoding: 'utf8' }));
for (const file of manifest.files) {
  if (file.includes('*')) {
    // npm-style glob entry (e.g. locale/*.json): require at least one match.
    const dir = dirname(file);
    const suffix = file.slice(file.lastIndexOf('*') + 1);
    const matches = readdirSync(dir).filter((name) => name.endsWith(suffix));
    assert.ok(matches.length > 0, `package.json files[] glob matches nothing: ${file}`);
    continue;
  }
  assert.ok(existsSync(file.replace(/\/$/, '')), `package.json files[] names a missing path: ${file}`);
}
const bundled = readdirSync('lib').filter((file) => file.endsWith('.mjs'));
assert.ok(bundled.length >= 1, 'lib/ has no runtime modules');

// The browser half must be declared the way the client module loader expects.
const clientEntry = manifest.exports?.['./client'];
assert.ok(typeof clientEntry === 'string' && existsSync(clientEntry), 'exports["./client"] must name an existing file');
assert.equal(manifest.dsh?.client?.platform, 'web');
assert.ok(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0,
  'dsh.client.inject must list the client modules the bundle requires');
// Metadata the plugin list reads (skill hard rule 11): icon + locale trio.
assert.equal(typeof manifest.icon, 'string', 'package.json must declare an icon');
assert.ok(existsSync(manifest.icon), `icon file is missing: ${manifest.icon}`);
assert.ok(manifest.exports?.['./locale/*.json'], 'exports must expose locale/*.json');
for (const language of ['en', 'zh']) {
  const localeFile = join('locale', `${language}.json`);
  assert.ok(existsSync(localeFile), `locale file is missing: ${localeFile}`);
  const meta = JSON.parse(readFileSync(localeFile, 'utf8'));
  assert.ok(meta.meta?.title && meta.meta?.description, `${localeFile} needs meta.title and meta.description`);
}

const clientSource = readFileSync(clientEntry, 'utf8');
assert.match(clientSource, /window\.__ModuleLoader__\.load\(/, 'the client bundle must register itself with the module loader');
assert.match(clientSource, new RegExp(`id: '${manifest.name}'`), 'the client bundle id must match the package name');

console.log(`ok  profile "${profileName}" composes the row: - id: session-md / name: dsh-session-md`);
console.log(`ok  bundle is not skipped by the compatibility gate`);
console.log(`ok  manifest files[] and lib/ are intact (${bundled.length} runtime module${bundled.length === 1 ? '' : 's'})`);
console.log('ok  client half declared: exports["./client"] + dsh.client (platform web, inject list)');
console.log('ok  plugin-list metadata present: icon.svg + locale/{en,zh}.json meta.title/description');
