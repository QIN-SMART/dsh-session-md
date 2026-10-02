#!/usr/bin/env node
/**
 * Real-Cordis integration test: module shape, hot-plug lifecycle, and execution.
 *
 * This is the test that would have caught the two defects that broke the first
 * install:
 *
 *   1. `export default apply` — Cordis normalizes a module with
 *      `exports.default ?? exports`, so the default export replaced the plugin
 *      object and dropped `name` / `inject`, killing the plugin at mount with
 *      `cannot get property "tools" without inject`.
 *   2. Reading `ctx.fs` / `ctx.sessionPersistence` without declaring them in
 *      `inject` — Cordis throws on ANY undeclared service read, so the write
 *      path blew up at runtime.
 *
 * The plugin is therefore loaded exactly the way the loader loads it, mounted on
 * a real `@deepseek-ai/cordis` Context with stub services that reproduce the
 * real contracts, and then executed: any undeclared service access throws here
 * instead of in the user's GUI.
 *
 *   node scripts/hotplug-test.mjs
 *
 * Skips (exit 0) when no DSH checkout can be located.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listSessions, readSessionFile } from './read-log.mjs';

/**
 * Resolve the `dsh` launcher the way each platform does it: `where` on Windows,
 * `which` elsewhere. Returns undefined when it is not on PATH.
 */
function findDshLauncher() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return undefined;
  }
}

/** Locate the Cordis package inside a DSH installation. */
function findCordis() {
  const candidates = [];
  const launcher = findDshLauncher();
  if (launcher !== undefined && launcher !== '') {
    try {
      candidates.push(dirname(dirname(realpathSync(launcher))));
    } catch {
      // A launcher we cannot realpath (shim, .cmd) tells us nothing; keep going.
    }
  }
  if (process.env.DSH_CHECKOUT !== undefined) candidates.push(process.env.DSH_CHECKOUT);
  for (const checkout of candidates) {
    const entry = join(checkout, 'node_modules/@deepseek-ai/cordis/lib/index.js');
    if (existsSync(entry)) return { entry, nodeModules: join(checkout, 'node_modules') };
  }
  return undefined;
}

const cordis = findCordis();
const cordisEntry = cordis?.entry;
if (cordis === undefined) {
  console.log('skip: no DSH checkout with @deepseek-ai/cordis found (set DSH_CHECKOUT to enable)');
  process.exit(0);
}

const { Context, Service } = await import(cordisEntry);

/** Load the plugin exactly like `cordis-plugin-loader` does. */
const moduleNamespace = await import('../index.mjs');
const loadedPlugin = moduleNamespace.default ?? moduleNamespace;

const available = listSessions().filter((session) => statSync(session.file).size > 4096);
if (available.length < 2) {
  // Fresh machines and CI have no DSH session logs; nothing to mount against.
  console.log('skip: needs at least two non-trivial stored sessions (set DSH_HOME to a profile with sessions)');
  process.exit(0);
}

const primary = readSessionFile(available[0].file);
const secondLog = readSessionFile(available[1].file);
const child = { ...secondLog.header, origin: 'subagent', parentSession: primary.header.id, delegationDepth: 1 };

/** Stub of the real tool registry: fiber-bound registration, like dsh-tools. */
class Tools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.tools = new Map();
  }

  register(definition) {
    const registry = this.tools;
    return this.ctx.effect(function* () {
      if (registry.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      registry.set(definition.name, definition);
      yield () => registry.delete(definition.name);
    }, 'tools.register()');
  }
}

/** Stub of the session store: one live session, one stored child. */
class Sessions extends Service {
  constructor(ctx) {
    super(ctx, 'sessions');
    this.live = new Map([[primary.header.id, {
      header: primary.header,
      snapshotEvents: () => primary.events,
    }]]);
  }

  get(id) {
    return this.live.get(id);
  }

  list() {
    return [...this.live.values()];
  }

  async flush() {
    return true;
  }
}

/** Stub of the persistence service: read handles over the stored child only. */
class Persistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence');
  }

  async list() {
    return [{ header: child }];
  }

  async open(id) {
    if (id !== child.id) throw new Error(`no such stored session: ${id}`);
    return {
      id,
      header: child,
      read: async () => ({ eventState: 'owned', events: secondLog.events }),
      close: async () => {},
    };
  }
}

/** Stub of the filesystem service: real bytes on disk, real write-intent semantics. */
class Fs extends Service {
  constructor(ctx) {
    super(ctx, 'fs');
  }

  async resolve(path) {
    return { targetKey: path, displayPath: path };
  }

  async stat(target) {
    if (!existsSync(target.targetKey)) return undefined;
    if (!statSync(target.targetKey).isFile()) return { type: 'directory', version: 'v0' };
    return { type: 'file', version: `size:${statSync(target.targetKey).size}` };
  }

  async writeText(target, content, intent) {
    if (intent?.kind === 'createIfAbsent' && existsSync(target.targetKey)) {
      throw new Error(`cannot overwrite existing "${target.displayPath}" without reading it first`);
    }
    // The real local backend creates missing parents; mirror that here.
    mkdirSync(dirname(target.targetKey), { recursive: true });
    writeFileSync(target.targetKey, content, 'utf8');
    return { operation: 'update', version: `size:${Buffer.byteLength(content)}` };
  }
}

/** Stub of the client-connection service: records exact Fetch routes. */
class Connection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
    this.routes = new Map();
    const routes = this.routes;
    this.fetch = {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    };
  }
}

const root = new Context();
await root.plugin(Connection);
await root.plugin(Tools);
await root.plugin(Sessions);
await root.plugin(Persistence);
await root.plugin(Fs);

const workdir = mkdtempSync(join(tmpdir(), 'dsh-session-md-cordis-'));
let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}\n     ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}

await test('every declared client module really has a browser half', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = manifest.dsh?.client?.inject ?? [];
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(declared.length > 0, 'the client half must declare its client modules');
  const { nodeModules } = cordis;
  for (const id of declared) {
    const packageJson = join(nodeModules, id, 'package.json');
    assert.ok(existsSync(packageJson), `declared client module is not installed: ${id}`);
    const meta = JSON.parse(readFileSync(packageJson, 'utf8'));
    assert.ok(meta.dsh?.client, `${id} declares no dsh.client half — it must not be listed in dsh.client.inject`);
  }
  // The modules the bundle requires without declaring them are plain libraries.
  for (const id of ['@deepseek-ai/dsh-client-ui-primitives']) {
    assert.ok(existsSync(join(nodeModules, id, 'package.json')), `bundle requires a missing module: ${id}`);
  }
});

await test('the module exports named bindings only (no default export)', () => {
  assert.equal('default' in moduleNamespace, false, 'a default export would replace the plugin object');
  assert.equal(loadedPlugin.name, 'session-md');
  assert.deepEqual(loadedPlugin.inject, ['tools', 'sessions', 'sessionPersistence', 'fs']);
  assert.equal(typeof loadedPlugin.apply, 'function');
});

await test('a fresh mount registers exactly one tool', async () => {
  const fork = await root.plugin(loadedPlugin);
  assert.deepEqual([...root.tools.tools.keys()], ['export_session_md']);
  await fork.dispose();
});

await test('unloading the plugin fiber removes the tool (no leak)', async () => {
  const fork = await root.plugin(loadedPlugin);
  assert.equal(root.tools.tools.size, 1);
  await fork.dispose();
  assert.equal(root.tools.tools.size, 0, 'the tool must vanish with the plugin fiber');
});

await test('re-loading after unload works (hot swap, no duplicate error)', async () => {
  const first = await root.plugin(loadedPlugin);
  await first.dispose();
  const second = await root.plugin(loadedPlugin);
  assert.deepEqual([...root.tools.tools.keys()], ['export_session_md']);
  await second.dispose();
});

let execFork;
await test('executing the tool inside Cordis reaches only declared services', async () => {
  execFork = await root.plugin(loadedPlugin);
  const definition = root.tools.tools.get('export_session_md');
  const result = await definition.execute(
    { path: join(workdir, 'live'), includeSubagents: false },
    {
      agent: { sessionId: primary.header.id, session: root.sessions.get(primary.header.id) },
      signal: AbortSignal.timeout(60_000),
    },
  );
  assert.equal(result.count, 1, 'the live session exports');
  assert.ok(readFileSync(result.files[0], 'utf8').startsWith('# '));
});

await test('the stored-session path works through the persistence service', async () => {
  const definition = root.tools.tools.get('export_session_md');
  const result = await definition.execute(
    { sessionId: child.id, path: join(workdir, 'stored'), includeSubagents: false },
    {
      agent: { sessionId: primary.header.id, session: root.sessions.get(primary.header.id) },
      signal: AbortSignal.timeout(60_000),
    },
  );
  assert.match(readFileSync(result.files[0], 'utf8'), /\| 来源 \| 子代理，深度 1/);
});

await test('the documented failure modes survive the real context', async () => {
  const definition = root.tools.tools.get('export_session_md');
  // An undeclared service read would have thrown during the two calls above, so
  // reaching this point already proves the inject list is complete.
  await assert.rejects(
    () => definition.execute({ sessionId: 'does-not-exist' }, { signal: AbortSignal.timeout(10_000) }),
    /找不到会话|无法确定要导出的会话/,
  );
  await assert.rejects(
    () => definition.execute({ path: 42 }, { signal: AbortSignal.timeout(10_000) }),
    /必须是字符串/,
  );
});

await test('mounting registers the authenticated Markdown download route', async () => {
  const route = root.connection.routes.get('/api/session.export-md');
  assert.ok(route, 'the download route must be registered');
  assert.deepEqual(route.methods, ['GET', 'HEAD']);

  const response = await route.fetch(new Request(`http://127.0.0.1/api/session.export-md?sessionId=${primary.header.id}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/markdown/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="session-/);
  const body = await response.text();
  assert.ok(body.startsWith('# '), 'the download body is the Markdown document');
  assert.match(body, /\| 会话 \|/);
});

await test('the route honours the share switches and rejects bad input', async () => {
  const route = root.connection.routes.get('/api/session.export-md');
  const clean = await route.fetch(new Request(`http://127.0.0.1/api/session.export-md?sessionId=${primary.header.id}&clean=1&reasoning=0`));
  const cleanBody = await clean.text();
  const full = await route.fetch(new Request(`http://127.0.0.1/api/session.export-md?sessionId=${primary.header.id}`));
  const fullBody = await full.text();
  assert.ok(cleanBody.length < fullBody.length);
  assert.ok(!cleanBody.includes('**参数**') && fullBody.includes('**参数**'));

  const html = await route.fetch(new Request(`http://127.0.0.1/api/session.export-md?sessionId=${primary.header.id}&format=html&mode=readable`));
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.ok((await html.text()).startsWith('<!doctype html>'), 'the HTML format renders a self-contained page');

  const head = await route.fetch(new Request(`http://127.0.0.1/api/session.export-md?sessionId=${primary.header.id}`, { method: 'HEAD' }));
  assert.equal(await head.text(), '', 'HEAD answers headers only');

  assert.equal((await route.fetch(new Request('http://127.0.0.1/api/session.export-md'))).status, 400);
  assert.equal((await route.fetch(new Request('http://127.0.0.1/api/session.export-md?sessionId=nope'))).status, 404);
});

await test('a connection provided AFTER the plugin still gets the route (late provisioning)', async () => {
  // The real Web profile binds the server — and provides `connection` — after
  // bundle plugins apply. Sampling `ctx.get('connection')` once at mount
  // registered nothing there and the button 404ed; dynamic injection must wait.
  const { Context: ContextClass, Service: ServiceClass } = await import(cordisEntry);
  class LateTools extends ServiceClass {
    constructor(ctx) {
      super(ctx, 'tools');
      this.tools = new Map();
    }

    register() {
      return () => {};
    }
  }
  class LateSessions extends ServiceClass {
    constructor(ctx) {
      super(ctx, 'sessions');
    }
  }
  class LatePersistence extends ServiceClass {
    constructor(ctx) {
      super(ctx, 'sessionPersistence');
    }
  }
  class LateFs extends ServiceClass {
    constructor(ctx) {
      super(ctx, 'fs');
    }
  }
  const late = new ContextClass();
  await late.plugin(LateTools);
  await late.plugin(LateSessions);
  await late.plugin(LatePersistence);
  await late.plugin(LateFs);
  const fork = await late.plugin(loadedPlugin);
  const lateConnection = await late.plugin(Connection);
  assert.equal(late.connection.routes.has('/api/session.export-md'), true,
    'the route must appear once the connection service is provided');
  await fork.dispose();
  assert.equal(late.connection.routes.has('/api/session.export-md'), false,
    'unloading the plugin must release a late-registered route too');
  await lateConnection.dispose();
});

await test('unloading after execution still leaves no residue', async () => {
  await execFork.dispose();
  assert.equal(root.tools.tools.size, 0);
  assert.equal(root.connection.routes.has('/api/session.export-md'), false, 'the route must vanish with the plugin fiber');
});

rmSync(workdir, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}`);
