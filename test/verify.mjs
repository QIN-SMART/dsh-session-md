/**
 * `node --test test/verify.mjs`
 *
 * Covers the plugin contract and the export modes end to end at the module
 * level: shape and exports, mode presets and their overrides, what each preset
 * actually puts in the document, the tool's `both` behaviour, the Host download
 * route (including a late-provisioned connection), and the client bundle's menu.
 *
 * The heavier real-Cordis checks live in `scripts/` and run from `npm run check`;
 * these cases stay fast and dependency-free.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { markdownToHtml, markdownToHtmlBody } from '../lib/html.mjs';
import { MODE_NAMES, MODES, deriveDocumentTitle, optionsForMode, renderSession, slugify } from '../lib/render.mjs';
import * as host from '../index.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'));

/* ── fixture ─────────────────────────────────────────────────────────────── */

const T = Date.UTC(2026, 0, 2, 3, 4, 5);
const HEADER = {
  version: 4,
  id: 'session-fixture',
  createdAt: T,
  cwd: '/tmp/ws',
  isSeeded: false,
  origin: 'subagent',
  delegationDepth: 1,
  parentSession: 'session-parent',
  agentPreset: 'standard',
};
const EVENTS = [
  { type: 'session/title', seq: 1, time: T, data: { title: '夹具会话' } },
  {
    type: 'request/header',
    seq: 2,
    time: T,
    data: { header: { config: { provider: 'p', model: 'm' }, system: 'SYS-PROMPT' } },
  },
  { type: 'turn/start', seq: 3, time: T, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 4,
    time: T,
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } },
  },
  {
    type: 'user/message',
    seq: 5,
    time: T,
    data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '运行时注入' }], source: { kind: 'runtime-context' } },
  },
  {
    type: 'assistant/message',
    seq: 6,
    time: T,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '思考 A' },
          { type: 'text', text: '正文 A' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls","description":"列目录"}' },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 7, time: T, data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls","description":"列目录"}' } },
  {
    type: 'tool/result',
    seq: 8,
    time: T,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_1',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'FILE-LISTING' }] }],
      },
    },
  },
  { type: 'turn/end', seq: 9, time: T, data: { turn: 1, reason: 'done' } },
];

const render = (options) => renderSession({ header: HEADER, events: EVENTS, options });

/* ── module shape ────────────────────────────────────────────────────────── */

test('host module exports named bindings only', () => {
  assert.equal(typeof host.apply, 'function');
  assert.equal(host.name, PACKAGE.name === 'dsh-session-md' ? 'session-md' : host.name);
  assert.deepEqual(host.inject, ['tools', 'sessions', 'sessionPersistence', 'fs']);
  const source = readFileSync(join(ROOT, '..', 'index.mjs'), 'utf8');
  assert.equal(/^export default/m.test(source), false,
    'a default export would replace the plugin object and drop inject');
  assert.match(source, /export \{ apply, inject, name \}|export const name|export function apply/);
});

test('package manifest declares the bundle, the client half and metadata', () => {
  assert.equal(PACKAGE.name, 'dsh-session-md');
  assert.equal(PACKAGE.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(PACKAGE.dsh.client.platform, 'web');
  assert.equal(PACKAGE.dsh.manifestVersion, 1);
  assert.equal(PACKAGE.icon, './icon.svg');
  assert.ok(PACKAGE.exports['./client']);
  assert.ok(PACKAGE.exports['./locale/*.json']);
  for (const id of PACKAGE.dsh.client.inject) {
    assert.match(id, /^@deepseek-ai\/dsh-client-/);
  }
  assert.ok(existsSync(join(ROOT, '..', 'locale', 'zh.json')));
  assert.ok(existsSync(join(ROOT, '..', 'locale', 'en.json')));
  assert.ok(existsSync(join(ROOT, '..', 'icon.svg')));
  for (const kind of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(ROOT, '..', 'locale', `${kind}.json`), 'utf8'));
    assert.ok(meta.meta.title && meta.meta.description, `${kind} locale needs meta.title/description`);
  }
});

/* ── modes ───────────────────────────────────────────────────────────────── */

test('every mode resolves to a distinct, complete option set', () => {
  assert.deepEqual(MODE_NAMES, ['full', 'handoff', 'readable', 'audit']);
  for (const mode of MODE_NAMES) {
    const options = optionsForMode(mode);
    assert.deepEqual(MODES[mode], { ...MODES[mode] });
    assert.equal(typeof options.includeToolDetails, 'boolean');
    assert.equal(typeof options.includeReasoning, 'boolean');
    assert.equal(typeof options.maxToolResultChars, 'number');
  }
  assert.throws(() => optionsForMode('nope'), /unknown mode/);
});

test('explicit overrides win over the preset', () => {
  const options = optionsForMode('readable', { includeToolDetails: true, maxToolResultChars: 123 });
  assert.equal(options.includeToolDetails, true);
  assert.equal(options.maxToolResultChars, 123);
  assert.equal(options.includeReasoning, MODES.readable.includeReasoning);
});

test('readable hides tool payloads, full keeps them', () => {
  const full = render(optionsForMode('full'));
  const readable = render(optionsForMode('readable'));
  assert.ok(full.includes('FILE-LISTING') && full.includes('**参数**'));
  assert.ok(!readable.includes('FILE-LISTING') && !readable.includes('**参数**'));
  assert.ok(readable.includes('`bash`'), 'the tool name survives in readable mode');
  assert.ok(readable.length < full.length);
});

test('handoff keeps tool calls but drops reasoning', () => {
  const handoff = render(optionsForMode('handoff'));
  assert.ok(handoff.includes('FILE-LISTING'));
  assert.ok(!handoff.includes('思考 A'));
  assert.ok(!handoff.includes('SYS-PROMPT'));
  assert.ok(!handoff.includes('运行时注入'));
});

test('audit keeps everything untruncated', () => {
  const audit = render(optionsForMode('audit'));
  assert.ok(audit.includes('SYS-PROMPT'));
  assert.ok(audit.includes('运行时注入'));
  assert.ok(audit.includes('思考 A'));
  assert.ok(audit.includes('FILE-LISTING'));
});

test('mode presets are reflected in the tool schema', () => {
  const { definition } = mountPlugin();
  const modes = definition.parameters.properties.mode;
  assert.deepEqual(modes.enum, ['full', 'handoff', 'readable', 'audit', 'both']);
  assert.match(definition.description, /full = everything/);
});

/* ── host plugin, tool and route ─────────────────────────────────────────── */

/** Build a stub ctx that behaves like the real services this plugin reads. */
function stubContext(workdir) {
  const registered = [];
  const routes = new Map();
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    sessions: {
      get: (id) => (id === HEADER.id ? { header: HEADER, snapshotEvents: () => EVENTS } : undefined),
      list: () => [{ header: HEADER, snapshotEvents: () => EVENTS }],
      flush: async () => true,
    },
    sessionPersistence: {
      list: async () => [],
      open: async (id) => {
        throw new Error(`no such stored session: ${id}`);
      },
    },
    fs: {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      stat: async (target) => (existsSync(target.targetKey) && statSync(target.targetKey).isFile()
        ? { type: 'file', version: `size:${statSync(target.targetKey).size}` }
        : undefined),
      writeText: async (target, content) => {
        mkdirSync(dirname(target.targetKey), { recursive: true });
        writeFileSync(target.targetKey, content, 'utf8');
        return { operation: 'create', version: `size:${Buffer.byteLength(content)}` };
      },
    },
    get: () => undefined,
    emit: () => {},
    // Dynamic injection: hand the callback a scope carrying the stub connection.
    inject: (names, callback) => {
      assert.deepEqual(names, ['connection']);
      callback({
        connection: {
          fetch: {
            register: (route) => {
              routes.set(route.path, route);
              return () => routes.delete(route.path);
            },
          },
        },
        effect: (body) => (typeof body === 'function' ? body() : undefined),
      });
    },
    logger: { info: () => {} },
  };
  // The tool registry stub above must stay first for `mountPlugin`; re-expose it.
  return { ctx, registered, routes };
}

/** Mount the plugin on a stub context and return everything it registered. */
function mountPlugin(workdir) {
  const { ctx, registered, routes } = stubContext(workdir);
  host.apply(ctx);
  return { definition: registered[0], routes };
}

test('the tool writes one document in the plain name and two when mode is both', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-session-md-verify-'));
  try {
    const { definition } = mountPlugin(workdir);
    const exec = { agent: { sessionId: HEADER.id, session: { header: HEADER } }, signal: AbortSignal.timeout(30_000) };

    const single = await definition.execute({ path: workdir, includeSubagents: false }, exec);
    assert.equal(single.count, 1);
    assert.match(single.files[0], /session-fixture\.md$/);

    const both = await definition.execute({ mode: 'both', path: join(workdir, 'both'), includeSubagents: false }, exec);
    assert.equal(both.count, 2);
    assert.match(both.files[0], /session-fixture\.full\.md$/);
    assert.match(both.files[1], /session-fixture\.readable\.md$/);
    const fullBody = readFileSync(both.files[0], 'utf8');
    const readableBody = readFileSync(both.files[1], 'utf8');
    assert.ok(fullBody.includes('FILE-LISTING') && !readableBody.includes('FILE-LISTING'));
    assert.ok(both.bytes > single.bytes);

    const html = await definition.execute({ format: 'html', path: join(workdir, 'html'), includeSubagents: false }, exec);
    assert.equal(html.count, 1);
    assert.match(html.files[0], /session-fixture\.html$/);
    const htmlBody = readFileSync(html.files[0], 'utf8');
    assert.ok(htmlBody.startsWith('<!doctype html>'));
    assert.ok(htmlBody.includes('@media print'));

    const bothHtml = await definition.execute(
      { mode: 'both', format: 'html', path: join(workdir, 'both-html'), includeSubagents: false },
      exec,
    );
    assert.match(bothHtml.files[0], /session-fixture\.full\.html$/);
    assert.match(bothHtml.files[1], /session-fixture\.readable\.html$/);

    await assert.rejects(() => definition.execute({ mode: 'bogus' }, exec), /mode 必须是/);
    await assert.rejects(() => definition.execute({ format: 'pdf' }, exec), /format 必须是/);
    await assert.rejects(() => definition.execute({ mode: 'readable', includeToolDetails: 'yes' }, exec), /布尔值/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('the download route serves every preset and rejects unknown ones', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-session-md-route-'));
  try {
    const { routes } = mountPlugin(workdir);
    const route = routes.get('/api/session.export-md');
    assert.ok(route, 'the route registers through dynamic injection');
    const call = (query) => route.fetch(new Request(`http://127.0.0.1/api/session.export-md?${query}`));

    const full = await call(`sessionId=${HEADER.id}`);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type'), /text\/markdown/);
    assert.ok((await full.text()).includes('FILE-LISTING'));

    const readable = await call(`sessionId=${HEADER.id}&mode=readable`);
    const readableBody = await readable.text();
    assert.ok(!readableBody.includes('FILE-LISTING'));

    const both = await call(`sessionId=${HEADER.id}&mode=both`);
    assert.equal(both.status, 200, 'both degrades to a single document for a download');
    assert.ok((await both.text()).includes('FILE-LISTING'));

    const html = await call(`sessionId=${HEADER.id}&format=html`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.headers.get('content-disposition'), /attachment; filename="/);
    assert.ok((await html.text()).startsWith('<!doctype html>'));

    assert.equal((await call(`sessionId=${HEADER.id}&format=pdf`)).status, 400);
    assert.equal((await call(`sessionId=${HEADER.id}&mode=bogus`)).status, 400);
    // Input is validated before storage, so a bad mode is a 400 even for an unknown session.
    assert.equal((await call('sessionId=nope&mode=bogus')).status, 400);
    assert.equal((await call('mode=full')).status, 400);
    assert.equal((await call('sessionId=nope')).status, 404);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

/* ── client bundle ───────────────────────────────────────────────────────── */

test('the client bundle mounts a five-entry mode menu and builds correct URLs', () => {
  let loaded;
  const created = [];
  const anchors = [];
  const documentDouble = {
    createElement: (tag) => {
      const element = {
        tag,
        href: undefined,
        style: {},
        clicked: 0,
        appendChild() {},
        remove() {},
        click() {
          this.clicked += 1;
          anchors.push(this);
        },
      };
      created.push(element);
      return element;
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  const reactDouble = {
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  const requireDouble = (id) => {
    if (id === 'react') return reactDouble;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'Button', Menu: 'Menu', IconDownloadOutlineRegular: 'Icon' };
    throw new Error(`unexpected require("${id}")`);
  };
  const source = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8');
  new Function('window', 'document', source)(
    { __ModuleLoader__: { load: (entry) => { loaded = entry; } } },
    documentDouble,
  );
  assert.equal(loaded.id, PACKAGE.name, 'the client bundle id must equal the package name');
  const client = loaded.factory(requireDouble);
  assert.deepEqual(client.inject, ['slots', 'locale']);

  let Component;
  client.apply({
    effect: (body) => (typeof body === 'function' ? body() : undefined),
    locale: { register: () => {} },
    slots: { inject: (_name, fn) => fn(), register: (_contribution, component) => { Component = component; } },
  });
  const element = Component({ sessionId: 's-1', t: (key) => key });
  assert.equal(element.type, 'Menu');
  assert.deepEqual(element.props.items.map((item) => item.id),
    ['full', 'handoff', 'readable', 'audit', 'both', 'html-full', 'html-readable']);

  element.props.onSelect('handoff');
  assert.deepEqual(anchors.map((anchor) => anchor.href), ['api/session.export-md?sessionId=s-1&mode=handoff']);
  element.props.onSelect('both');
  assert.deepEqual(anchors.slice(1).map((anchor) => anchor.href), [
    'api/session.export-md?sessionId=s-1&mode=full',
    'api/session.export-md?sessionId=s-1&mode=readable',
  ]);
  element.props.onSelect('html-readable');
  assert.equal(anchors.at(-1).href, 'api/session.export-md?sessionId=s-1&mode=readable&format=html');
});

/* ── HTML rendering ──────────────────────────────────────────────────────── */

test('html export is one self-contained page with no external requests', () => {
  const html = markdownToHtml({ markdown: render(optionsForMode('full')) });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<style>[\s\S]*@media print/);
  assert.ok(!/src="https?:/.test(html), 'no remote scripts/images');
  assert.ok(!/href="https:\/\/fonts/.test(html), 'no remote fonts');
  assert.ok(html.includes('<details>') && html.includes('<summary>'), 'collapsible sections are preserved');
});

test('html rendering escapes content and keeps neutralized tags as text', () => {
  const malicious = '# t\n\n<script>alert(1)</script> & <img src=x onerror=alert(1)>\n\n&lt;details&gt; 已经是实体\n';
  const body = markdownToHtmlBody(malicious);
  assert.ok(!body.includes('<script>alert'), 'raw script tags from content must not survive');
  assert.ok(body.includes('&lt;script&gt;'));
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(body.includes('&lt;details&gt; 已经是实体'), 'existing entities are not double-escaped');
  assert.ok(!body.includes('&amp;lt;details'));
});

test('html rendering covers headings, tables, lists, quotes, code and rules', () => {
  const body = markdownToHtmlBody([
    '## Turn 1',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [x] done',
    '- plain',
    '',
    '1. first',
    '',
    '> quoted',
    '',
    '\`\`\`json',
    '{"a":1}',
    '\`\`\`',
    '',
    '---',
    '',
    'A paragraph with **bold** and \`code` and [a link](https://example.com).',
  ].join('\n'));
  for (const expected of [
    '<h2>Turn 1</h2>', '<table>', '<th>a</th>', '<td>1</td>',
    '<ul>', 'type="checkbox" disabled checked', '<li>plain</li>',
    '<ol>', '<li>first</li>', '<blockquote>quoted</blockquote>',
    'class="language-json"', '<hr>', '<strong>bold</strong>', '<code>code</code>',
    '<a href="https://example.com" rel="noopener noreferrer">a link</a>',
  ]) {
    assert.ok(body.includes(expected), `missing ${expected}`);
  }
});

test('html link targets are scheme-checked', () => {
  const body = markdownToHtmlBody('[x](javascript:alert(1)) [y](https://ok.example)');
  assert.ok(!body.includes('javascript:'));
  assert.ok(body.includes('href="https://ok.example"'));
});

/* ── pure helpers ────────────────────────────────────────────────────────── */

test('title derivation and slugging stay stable', () => {
  assert.equal(deriveDocumentTitle(HEADER, EVENTS), '夹具会话');
  assert.equal(deriveDocumentTitle({ id: 'x' }, []), '会话 x');
  assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'abcdefghi');
  assert.ok(slugify('x'.repeat(200)).length <= 40);
});

/* ── Windows safety ─────────────────────────────────────────────────────── */

test('export file names are valid on Windows', () => {
  // Forbidden characters.
  assert.equal(slugify('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
  // Control characters never reach a file name.
  assert.equal(slugify('a\u0000b\u001fc'), 'abc');
  // Trailing dot / space are silently dropped by Windows and must not survive.
  assert.equal(slugify('report.'), 'report');
  assert.equal(slugify('report '), 'report');
  assert.equal(slugify('  spaced  '), 'spaced');
  // Reserved device names, with or without an extension.
  for (const reserved of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9', 'CON.md', 'nul.txt']) {
    const slug = slugify(reserved);
    assert.ok(slug.startsWith('_'), `${reserved} must be escaped, got ${slug}`);
  }
  // Nothing that could be mistaken for a device name after the extension logic.
  assert.equal(slugify('console'), 'console');
  assert.equal(slugify(''), 'session');
  // A slug is always a usable stem once we append `.md` / `.html`.
  for (const title of ['con', 'x.'.repeat(40), '中文标题 / 带斜杠', 'a'.repeat(300)]) {
    const name = `${slugify(title, 60)}.md`;
    assert.ok(name.length <= 63, name);
    assert.ok(!/[\\/:*?"<>|]/.test(name), name);
    assert.ok(!/[. ]\./.test(name), name);
  }
});

test('the runtime never shells out or hardcodes platform paths', () => {
  const runtime = ['index.mjs', 'lib/render.mjs', 'lib/html.mjs', 'lib/client.js']
    .map((file) => [file, readFileSync(join(ROOT, '..', file), 'utf8')]);
  for (const [file, source] of runtime) {
    assert.equal(/from 'node:child_process'|require\('node:child_process'\)|execFile|execSync|spawn\(/.test(source), false,
      `${file} must not spawn processes — that is where Windows breaks`);
    assert.equal(/['"]\/(usr|Users|home|tmp|var)\//.test(source), false,
      `${file} must not hardcode a POSIX absolute path`);
  }
  // Paths are composed with node:path, never with string concatenation.
  const hostSource = readFileSync(join(ROOT, '..', 'index.mjs'), 'utf8');
  assert.match(hostSource, /from 'node:path'/);
  assert.equal(/join\([^)]*\+ *['"]\//.test(hostSource), false);
});

test('npm scripts stay shell-agnostic', () => {
  for (const [name, command] of Object.entries(PACKAGE.scripts ?? {})) {
    assert.equal(/\brm \b|\bcp \b|\bmv \b|\bfind \b|\bwhich \b|&&\s*$/.test(command), false,
      `script "${name}" uses a POSIX-only shell verb: ${command}`);
  }
  assert.equal(PACKAGE.engines.node, '^22.19.0 || >=24');
});
