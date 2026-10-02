#!/usr/bin/env node
/**
 * End-to-end smoke test for the plugin's host half.
 *
 * `index.mjs` is imported as DSH would import it, mounted on a stub Cordis
 * context whose `sessions` / `sessionPersistence` services are backed by real
 * stored logs, and then the registered `export_session_md` tool is executed
 * against a temporary directory. This exercises argument handling, live and
 * stored session reads, subagent collection, path resolution, document
 * writing and the declared output schema — without touching a real profile.
 *
 *   node scripts/plugin-smoke.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, inject, name } from '../index.mjs';
import { listSessions, readSessionFile } from './read-log.mjs';

const available = listSessions().filter((session) => statSync(session.file).size > 4096);
if (available.length < 2) {
  // CI and fresh checkouts have no session logs to export; skip instead of fail.
  console.log('skip: needs at least two non-trivial stored sessions (set DSH_HOME to a profile with sessions)');
  process.exit(0);
}

const [primary, secondary] = available;
const primaryLog = readSessionFile(primary.file);
const secondaryLog = readSessionFile(secondary.file);

// Present `secondary` as a subagent child of `primary` to exercise descendant export.
const childHeader = { ...secondaryLog.header, origin: 'subagent', parentSession: primaryLog.header.id, delegationDepth: 1 };
const live = new Map([
  [primaryLog.header.id, { header: primaryLog.header, snapshotEvents: () => primaryLog.events }],
]);
const stored = new Map([
  [childHeader.id, { header: childHeader, events: secondaryLog.events }],
]);

const registered = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  sessions: {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    async flush() {
      return true;
    },
  },
  sessionPersistence: {
    list: async () => [...stored.values()].map((entry) => ({ header: entry.header })),
    open: async (id) => {
      const entry = stored.get(id);
      if (entry === undefined) throw new Error(`no such stored session: ${id}`);
      return {
        id,
        header: entry.header,
        read: async () => ({ eventState: 'owned', events: entry.events }),
        close: async () => {},
      };
    },
  },
  // Filesystem and sandbox-policy services, modelled on the real contracts.
  fs: {
    async resolve(path) { return { targetKey: path, displayPath: path }; },
    async stat(target) {
      if (!existsSync(target.targetKey)) return undefined;
      if (!statSync(target.targetKey).isFile()) return { type: 'directory', version: 'v0' };
      return { type: 'file', version: `size:${statSync(target.targetKey).size}` };
    },
    async writeText(target, content, intent) {
      if (intent?.kind === 'createIfAbsent' && existsSync(target.targetKey)) {
        throw new Error(`cannot overwrite existing "${target.displayPath}" without reading it first`);
      }
      mkdirSync(dirname(target.targetKey), { recursive: true });
      writeFileSync(target.targetKey, content, 'utf8');
      return { operation: 'create', version: `size:${Buffer.byteLength(content)}` };
    },
  },
  get(service) { return service === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workdir }) } : undefined; },
  // This stub mounts no Connection service, so the plugin's Web-only download
  // route never registers here — the Cordis-context tests cover that path.
  inject() {},
  emit() {},
  logger: { info() {} },
};

apply(ctx);

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

const tool = registered[0];
assert.equal(registered.length, 1, 'exactly one tool is registered');
assert.equal(tool.name, 'export_session_md');
assert.equal(name, 'session-md');
assert.deepEqual(inject, ['tools', 'sessions', 'sessionPersistence', 'fs']);

const workdir = mkdtempSync(join(tmpdir(), 'dsh-session-md-smoke-'));
const current = live.get(primaryLog.header.id);
/** Execute the tool the way an agent loop would: with the calling agent attached. */
const exec = (args) => tool.execute(args, {
  agent: { sessionId: primaryLog.header.id, session: current },
  signal: AbortSignal.timeout(60_000),
});

await test('exports the current session into a directory', async () => {
  const result = await exec({ path: workdir, includeSubagents: false });
  assert.equal(result.count, 1);
  assert.equal(result.files.length, 1);
  assert.ok(result.bytes > 1000);
  const body = readFileSync(result.files[0], 'utf8');
  assert.ok(body.startsWith('# '));
  assert.match(body, /\| 会话 \|/);
  assert.ok(result.files[0].startsWith(workdir));
});

await test('writes an exact .md destination and overwrites it on a re-run', async () => {
  const target = join(workdir, 'exact.md');
  const first = await exec({ path: target, includeSubagents: false });
  assert.equal(first.count, 1);
  assert.equal(first.files[0], target);
  const second = await exec({ path: target, includeSubagents: false });
  assert.equal(second.count, 1, 'a second export replaces the file instead of failing');
  assert.equal(statSync(target).size, second.bytes);
});

await test('exports stored subagent sessions beside their root', async () => {
  const result = await exec({ path: workdir, includeSubagents: true });
  assert.equal(result.count, 2, 'root plus one child');
  const childFile = result.files.find((file) => file.includes('.subagents'));
  assert.ok(childFile, 'child document lands in the .subagents directory');
  const childBody = readFileSync(childFile, 'utf8');
  assert.match(childBody, /\| 来源 \| 子代理，深度 1/);
});

await test('the clean share version collapses tool sections', async () => {
  const full = await exec({ path: join(workdir, 'full.md'), includeSubagents: false });
  const clean = await exec({ path: join(workdir, 'clean.md'), includeToolDetails: false, includeSubagents: false });
  const sections = (body) => (body.match(/<details>/g) ?? []).length;
  const fullBody = readFileSync(full.files[0], 'utf8');
  const cleanBody = readFileSync(clean.files[0], 'utf8');
  assert.ok(fullBody.includes('**参数**'));
  assert.ok(sections(cleanBody) < sections(fullBody), 'tool sections collapse into one-line bullets');
  assert.ok(clean.bytes < full.bytes);
});

await test('all:true exports every root session', async () => {
  const result = await exec({ all: true, path: join(workdir, 'all'), includeSubagents: true });
  assert.equal(result.count, 2);
  for (const file of result.files) assert.ok(readFileSync(file, 'utf8').length > 100);
});

await test('the declared output schema matches what execute returns', async () => {
  const value = await exec({ path: join(workdir, 'schema'), includeSubagents: false });
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'count', 'files']);
  assert.ok(Array.isArray(value.files) && value.files.every((file) => typeof file === 'string'));
  assert.equal(typeof value.bytes, 'number');
  const rendered = tool.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('已导出 1 份 Markdown 文档'));
});

await test('unknown sessions and bad arguments fail with clear messages', async () => {
  await assert.rejects(() => exec({ sessionId: 'no-such-session' }), /找不到会话/);
  await assert.rejects(() => exec({ path: 42 }), /必须是字符串/);
  await assert.rejects(() => exec({ includeSubagents: 'yes' }), /必须是布尔值/);
  await assert.rejects(() => exec({ maxToolResultChars: -1 }), /非负整数/);
  await assert.rejects(() => exec({ all: true, path: join(workdir, 'x.md') }), /只能是目录/);
});

rmSync(workdir, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}`);
