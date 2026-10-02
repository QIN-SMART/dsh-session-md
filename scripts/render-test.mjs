#!/usr/bin/env node
/**
 * Renderer unit test over a synthetic session fixture.
 *
 * The fixture exercises every render path with known content, so the
 * assertions are structural facts about the renderer rather than guesses about
 * whatever real conversations happen to contain. Run: `node scripts/render-test.mjs`.
 */

import assert from 'node:assert/strict';
import { renderSession, slugify } from '../lib/render.mjs';

const T = Date.UTC(2026, 0, 2, 3, 4, 5);

const header = {
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

const events = [
  { type: 'session/title', seq: 1, time: T, data: { title: '夹具会话', source: 'provider' } },
  {
    type: 'request/header',
    seq: 2,
    time: T,
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' }, system: 'SYS-PROMPT <details> raw' } },
  },
  { type: 'turn/start', seq: 3, time: T, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 4,
    time: T,
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好 <details><summary>注入</summary>' }], source: { kind: 'user' } },
  },
  {
    type: 'user/message',
    seq: 5,
    time: T,
    data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '当前时间注入' }], source: { kind: 'time-context' } },
  },
  {
    type: 'assistant/message',
    seq: 6,
    time: T,
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 15 },
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: '思考 A' },
          { type: 'text', text: '正文 A' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls","description":"列出文件"}' },
        ],
      },
    },
  },
  {
    type: 'tool/call',
    seq: 7,
    time: T,
    data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls","description":"列出文件"}' },
  },
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
        content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file-a\nfile-b' }] },
          { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 2048, name: 'shot.png', width: 100, height: 50 } },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 9, time: T, data: { turn: 1, step: 1, callId: 'call_2', name: 'web_search', arguments: '{"query":"孤儿调用"}' } },
  {
    type: 'todo/write',
    seq: 10,
    time: T,
    data: { todos: [{ content: '第一项', status: 'completed' }, { content: '第二项', status: 'pending' }] },
  },
  { type: 'turn/end', seq: 11, time: T, data: { turn: 1, reason: 'done' } },
  { type: 'turn/start', seq: 12, time: T, data: { turn: 2 } },
  {
    type: 'user/message',
    seq: 13,
    time: T,
    data: { id: 'u3', role: 'user', content: [{ type: 'text', text: 'teammate says hi' }], source: { kind: 'agent-message' } },
  },
  {
    type: 'assistant/message',
    seq: 14,
    time: T,
    data: { turn: 2, step: 1, interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: '正文 B' }] } },
  },
  {
    type: 'tool/result',
    seq: 15,
    time: T,
    data: {
      turn: 2,
      step: 1,
      error: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
      message: {
        role: 'tool',
        toolCallId: 'call_1',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'bad args' }] }],
      },
    },
  },
  { type: 'compaction/summary', seq: 16, time: T, data: { summary: [{ type: 'text', text: '压缩摘要内容' }], shadowedTokenCount: 1234 } },
  {
    type: 'deliverables/presented',
    seq: 17,
    time: T,
    data: { turn: 2, callId: 'c', files: [{ path: 'out/report.md', description: '报告' }] },
  },
  { type: 'turn/end', seq: 18, time: T, data: { turn: 2, reason: 'done' } },
];

let passed = 0;
/** Named assertion. */
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

const base = renderSession({ header, events, exportedAt: '2026-01-02 11:04' });
const sectionCount = (markdown) => (markdown.match(/<details>/g) ?? []).length;

test('document starts with the in-log title and a metadata table', () => {
  assert.ok(base.startsWith('# 夹具会话\n'), base.slice(0, 40));
  assert.match(base, /\| 会话 \| `session-fixture` \|/);
  assert.match(base, /\| 来源 \| 子代理，深度 1，父会话 `session-parent` \|/);
  assert.match(base, /\| 模型 \| `deepseek-official\/deepseek-flash` \|/);
  assert.match(base, /合计 15 tokens/);
});

test('turns, user messages and assistant prose are rendered', () => {
  assert.match(base, /^## Turn 1$/m);
  assert.match(base, /^## Turn 2$/m);
  assert.match(base, /^### 👤 用户$/m);
  assert.match(base, /^### 🤖 助手$/m);
  assert.ok(base.includes('正文 A') && base.includes('正文 B'));
});

test('reasoning, tool call, result and attachment are rendered together', () => {
  assert.match(base, /🧠 思考过程/);
  assert.ok(base.includes('思考 A'));
  assert.match(base, /🔧 工具调用：`bash` · 列出文件/);
  assert.ok(base.includes('file-a') && base.includes('file-b'));
  assert.match(base, /📎 图片：shot.png，2\.0 KB，100×50/);
});

test('todos, compaction summary and deliverables are rendered as sections', () => {
  assert.ok(base.includes('- [x] 第一项') && base.includes('- [ ] 第二项'));
  assert.match(base, /🗜️ 上下文压缩摘要（压缩前 ≈1,234 tokens）/);
  assert.ok(base.includes('压缩摘要内容'));
  assert.match(base, /📦 交付文件：/);
  assert.ok(base.includes('`out/report.md` — 报告'));
});

test('errors, interrupts and orphaned tool calls are surfaced', () => {
  assert.ok(base.includes('❌'), 'errored tool call should be marked');
  assert.ok(base.includes('call_1') || base.includes('bad args'));
  assert.ok(base.includes('未完成的工具调用'));
  assert.ok(base.includes('`web_search`'));
  assert.match(base, /⚠️/);
});

test('injected context is excluded by default and included on request', () => {
  assert.ok(!base.includes('当前时间注入'));
  const wide = renderSession({ header, events, options: { includeInjectedContext: true } });
  assert.ok(wide.includes('当前时间注入'));
  assert.ok(wide.includes('⚙️ 注入上下文：time-context'));
  assert.ok(wide.length > base.length);
});

test('system prompt is excluded by default and included on request', () => {
  assert.ok(!base.includes('SYS-PROMPT'));
  const wide = renderSession({ header, events, options: { includeSystemPrompt: true } });
  assert.ok(wide.includes('SYS-PROMPT'));
  assert.ok(wide.includes('🧾 系统提示词'));
});

test('collaboration traffic stays in the share version', () => {
  assert.match(base, /### 🤝 协作消息（agent-message）/);
  assert.ok(base.includes('teammate says hi'));
});

test('includeToolDetails:false keeps tool names without arguments or results', () => {
  const clean = renderSession({ header, events, options: { includeToolDetails: false } });
  assert.ok(clean.includes('`bash`'));
  assert.ok(clean.includes('列出文件'), 'the one-line hint stays');
  assert.ok(!clean.includes('**参数**'));
  assert.ok(!clean.includes('**结果**'));
  assert.ok(!clean.includes('file-a'));
  assert.ok(sectionCount(clean) < sectionCount(base));
});

test('includeReasoning:false drops thinking blocks only', () => {
  const noThinking = renderSession({ header, events, options: { includeReasoning: false } });
  assert.ok(!noThinking.includes('思考 A'));
  assert.ok(noThinking.includes('正文 A'));
});

test('character bounds truncate instead of exploding', () => {
  const tight = renderSession({ header, events, options: { maxToolResultChars: 3, maxToolArgChars: 3, maxReasoningChars: 2 } });
  assert.ok(tight.includes('已截断'));
  assert.ok(tight.length < base.length);
});

test('content tags cannot break the document structure', () => {
  assert.ok(!base.includes('你好 <details>'), 'raw <details> from content must be neutralized');
  assert.ok(base.includes('&lt;details>'), 'the tag stays visible as text after neutralization');
  assert.ok(base.includes('&lt;/summary>'));
  assert.equal(sectionCount(base), (base.match(/<summary>/g) ?? []).length);
  assert.equal(sectionCount(base), (base.match(/<\/details>/g) ?? []).length);
});

test('rendering is deterministic and tolerates empties', () => {
  assert.equal(renderSession({ header, events }), renderSession({ header, events }));
  const empty = renderSession({ header: { id: 'x', createdAt: T, isSeeded: false }, events: [] });
  assert.ok(empty.startsWith('# 会话 x'));
});

test('slugify produces safe file names', () => {
  assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'abcdefghi');
  assert.equal(slugify('   '), 'session');
  assert.ok(slugify('x'.repeat(200)).length <= 40);
});

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}`);
