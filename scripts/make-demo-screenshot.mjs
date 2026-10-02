#!/usr/bin/env node
/**
 * Generate the README screenshot from a SYNTHETIC session.
 *
 * The repository never ships screenshots taken from a real profile: those would
 * contain real conversation titles, working directories and session ids. This
 * script builds a fabricated session in memory, renders it with the real
 * renderer (`lib/render.mjs` + `lib/html.mjs`), then asks a locally installed
 * Chromium-family browser for a screenshot of the result.
 *
 *   node scripts/make-demo-screenshot.mjs
 *
 * Output: docs/demo.html and docs/demo.png. Skips (exit 0) when no browser is
 * found, so it is safe to wire into any pipeline.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToHtml } from '../lib/html.mjs';
import { optionsForMode, renderSession } from '../lib/render.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'docs');
const T = Date.UTC(2026, 0, 2, 3, 4, 5);

/** A fabricated session: no real titles, paths, ids or conversation content. */
const HEADER = {
  version: 4,
  id: 'session-demo',
  createdAt: T,
  cwd: '/srv/demo/kuramoto-sim',
  isSeeded: false,
  agentPreset: 'standard',
};
const EVENTS = [
  { type: 'session/title', seq: 1, time: T, data: { title: 'Kuramoto 临界指数的 D 维推导' } },
  {
    type: 'request/header',
    seq: 2,
    time: T,
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' }, system: 'You are a coding agent.' } },
  },
  { type: 'turn/start', seq: 3, time: T, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 4,
    time: T,
    data: {
      turn: 1,
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '帮我确认 D 维 Kuramoto 模型在临界点附近的磁化率指数，并把关键文献列出来。' }],
    },
  },
  {
    type: 'assistant/message',
    seq: 5,
    time: T,
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 4820, outputTokens: 613, totalTokens: 5433 },
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: '先定位 Daido 2015 对磁化率的定义，再确认 \u03b3\u00b1 在 D>4 的平均场值与 D=4 的对数修正。' },
          { type: 'text', text: '分三步：先给结论，再给推导，最后列文献。\n\n## 结论\n\n平均场下 \u03b3\u207b = \u03b3\u207a = 1，与维度无关；D = 4 处出现对数修正。' },
          { type: 'tool-call', id: 'call_1', name: 'web_search', arguments: '{"query":"Daido 2015 Kuramoto susceptibility critical exponent"}' },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 6, time: T, data: { turn: 1, step: 1, callId: 'call_1', name: 'web_search', arguments: '{"query":"Daido 2015 Kuramoto susceptibility critical exponent"}' } },
  {
    type: 'tool/result',
    seq: 7,
    time: T,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_1',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '3 条结果：\n- Daido, Prog. Theor. Exp. Phys. 2015\n- Hong et al., PRE 2007\n- Coutinho et al., PRE 2013' }] }],
      },
    },
  },
  {
    type: 'todo/write',
    seq: 8,
    time: T,
    data: { todos: [{ content: '确认指数', status: 'completed' }, { content: '整理文献列表', status: 'in_progress' }] },
  },
  { type: 'turn/end', seq: 9, time: T, data: { turn: 1, reason: 'done' } },
];

/** Platform-aware candidate locations for a Chromium-family browser. */
function findBrowser() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome', 'msedge']) {
    const found = spawnSync(finder, [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim() !== '') return found.stdout.split(/\r?\n/)[0].trim();
  }
  return undefined;
}

const markdown = renderSession({ header: HEADER, events: EVENTS, options: optionsForMode('full'), exportedAt: '2026-01-02 11:04' });
const html = markdownToHtml({ markdown, title: 'dsh-session-md demo' });

mkdirSync(OUT_DIR, { recursive: true });
const htmlPath = join(OUT_DIR, 'demo.html');
writeFileSync(htmlPath, html, 'utf8');
console.log(`demo document: ${htmlPath}`);

const browser = findBrowser();
if (browser === undefined) {
  console.log('skip screenshot: no Chromium-family browser found (docs/demo.html is still written)');
  process.exit(0);
}

// Chrome writes the screenshot then sometimes lingers; spawnSync's timeout is
// the portable way to stop it, and the file is already on disk by then.
const profileDir = join(tmpdir(), `dsh-session-md-demo-${process.pid}`);
const shotPath = join(OUT_DIR, 'demo.png');
const args = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${profileDir}`,
  '--window-size=1200,1500',
  `--screenshot=${shotPath}`,
  `file://${htmlPath}`,
];
// `--headless=new` fails on GPU-less/containerised hosts (GPU process exit 6),
// so fall back to the legacy headless renderer before giving up. Disabling the
// browser sandbox is opt-in, never implicit: DSH_SESSION_MD_NO_SANDBOX=1.
const flagSets = [args, args.map((a) => (a === '--headless=new' ? '--headless=old' : a))];
if (process.env.DSH_SESSION_MD_NO_SANDBOX === '1') {
  flagSets.push(flagSets[1].concat(['--no-sandbox', '--disable-dev-shm-usage']));
}
let run;
for (const flags of flagSets) {
  run = spawnSync(browser, flags, { encoding: 'utf8', timeout: 60_000 });
  if (existsSync(shotPath)) break;
}
rmSync(profileDir, { recursive: true, force: true });

if (!existsSync(shotPath)) {
  console.log(`skip screenshot: browser produced nothing (${browser})${run.error ? ` — ${run.error.message}` : ''}`);
  process.exit(0);
}
const bytes = readFileSync(shotPath).length;
console.log(`demo screenshot: ${shotPath} (${(bytes / 1024).toFixed(0)} KB, synthetic data only)`);
