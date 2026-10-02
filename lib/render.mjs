/**
 * Pure Session-event → Markdown renderer for dsh-session-md.
 *
 * Input is plain lossless-JSON data — the exact `SessionEvent` records the
 * session log stores, plus a detached `SessionHeader` — so this module imports
 * nothing from DSH and can be unit-tested entirely offline against real logs.
 *
 * Layout:
 *   # <title>
 *   > meta blockquote
 *   ## Turn N
 *   ### 👤 用户 / 🤖 助手
 *   <details> 🧠 思考 / 🔧 工具调用 / 📝 待办 / 🗜️ 压缩摘要
 *
 * Only events that carry human-meaningful content are rendered; streaming
 * deltas (`*-chunks`, `assistant/chunk`), delivery acks, and bookkeeping are
 * deliberately dropped.
 */

/** Renderer defaults; every key is overridable per call. */
export const DEFAULT_OPTIONS = Object.freeze({
  /** Include tool arguments and results (false = tool names only). */
  includeToolDetails: true,
  /** Include assistant reasoning / thinking blocks. */
  includeReasoning: true,
  /** Include the request system prompt as a collapsed section. */
  includeSystemPrompt: false,
  /** Include machine-injected user-role context (time, runtime, skills, …). */
  includeInjectedContext: false,
  maxToolArgChars: 1200,
  maxToolResultChars: 4000,
  maxReasoningChars: 8000,
  maxTextChars: 60000,
  /** IANA zone for timestamps; undefined = host local time. */
  timeZone: undefined,
});

/**
 * Named export presets. A preset is a starting point, never a cage: the caller
 * layers explicitly-passed options on top (see {@link optionsForMode}).
 *
 * - `full`     — 全部：给别的 agent 接手或复现问题用。工具参数与结果都在，上限放宽。
 * - `handoff`  — 交接版：要工具调用链但不要思维链，超长结果截断，省 token。
 * - `readable` — 简洁：给人读。工具只留名字，无参数无结果。
 * - `audit`    — 审计：全量不截断，连系统提示词与注入上下文一起留档。
 */
export const MODES = Object.freeze({
  full: Object.freeze({
    includeToolDetails: true,
    includeReasoning: true,
    includeSystemPrompt: false,
    includeInjectedContext: false,
    maxToolArgChars: 4000,
    maxToolResultChars: 20000,
    maxReasoningChars: 20000,
    maxTextChars: 60000,
  }),
  handoff: Object.freeze({
    includeToolDetails: true,
    includeReasoning: false,
    includeSystemPrompt: false,
    includeInjectedContext: false,
    maxToolArgChars: 1500,
    maxToolResultChars: 4000,
    maxReasoningChars: 0,
    maxTextChars: 60000,
  }),
  readable: Object.freeze({
    includeToolDetails: false,
    includeReasoning: true,
    includeSystemPrompt: false,
    includeInjectedContext: false,
    maxToolArgChars: 0,
    maxToolResultChars: 0,
    maxReasoningChars: 6000,
    maxTextChars: 60000,
  }),
  audit: Object.freeze({
    includeToolDetails: true,
    includeReasoning: true,
    includeSystemPrompt: true,
    includeInjectedContext: true,
    maxToolArgChars: 0,
    maxToolResultChars: 0,
    maxReasoningChars: 0,
    maxTextChars: 0,
  }),
});

/** Preset names accepted by the renderer (the caller may add its own, e.g. `both`). */
export const MODE_NAMES = Object.freeze(Object.keys(MODES));

/**
 * Resolve one preset plus explicit overrides into complete renderer options.
 * @param {string} [mode] - one of {@link MODE_NAMES}; unknown names throw.
 * @param {object} [overrides] - explicitly-passed options; `undefined` entries keep the preset.
 * @returns {object} options accepted by {@link renderSession}.
 */
export function optionsForMode(mode = 'full', overrides = {}) {
  const preset = MODES[mode];
  if (preset === undefined) {
    throw new Error(`unknown mode "${mode}"; expected one of ${MODE_NAMES.join(', ')}`);
  }
  const options = { ...preset };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) options[key] = value;
  }
  return options;
}

/** Teammate / subagent traffic that belongs to the conversation even in share mode. */
const COLLAB_KINDS = new Set([
  'agent-message',
  'team-message',
  'subagent-report',
  'subagent-settled',
]);

/** Event types this renderer understands; everything else is ignored. */
const RENDERED_TYPES = new Set([
  'user/message',
  'system/message',
  'developer/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'compaction/summary',
  'deliverables/presented',
]);

/* ── small text utilities ────────────────────────────────────────────────── */

/** Fence long enough to survive backtick runs inside `text`. */
function fence(text) {
  const runs = String(text).match(/`+/g);
  const longest = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Fenced text block with an explicit language tag. */
function codeBlock(text, lang = '') {
  const body = String(text ?? '');
  const mark = fence(body);
  return `${mark}${lang}\n${body}\n${mark}`;
}

/** Clip one long field, keeping the reader aware of what was removed. */
function clip(text, max, what = '内容') {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max)}\n\n…（${what}已截断：全文 ${value.length.toLocaleString('en-US')} 字符，保留前 ${max.toLocaleString('en-US')} 字符）`;
}

/** Human byte size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Absolute local timestamp for humans, in the requested zone.
 * @param {number} ms - Unix epoch milliseconds.
 * @param {string} [timeZone] - IANA zone; omit for the host's local zone.
 */
export function formatTime(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/** One-line, fence-safe summary label. */
function inline(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** One opening or closing fence line, per the CommonMark-ish rule used here. */
function fenceMarkerOf(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return match === null ? undefined : { char: match[1][0], length: match[1].length, closes: match[2].trim() === '' };
}

/** Apply `transform` to every line that lies outside a fenced code block. */
function mapOutsideFences(text, transform) {
  const out = [];
  let open;
  for (const line of String(text ?? '').split('\n')) {
    const marker = fenceMarkerOf(line);
    if (marker !== undefined) {
      if (open !== undefined && open.char === marker.char && marker.length >= open.length && marker.closes) open = undefined;
      else if (open === undefined) open = marker;
      out.push(line);
      continue;
    }
    out.push(open === undefined ? transform(line) : line);
  }
  return out.join('\n');
}

/** Nest content headings below the message heading; fenced code is untouched. */
function demoteHeadings(text) {
  return mapOutsideFences(text, (line) => line.replace(/^(#{1,6}) /, (_match, hashes) => `${'#'.repeat(Math.min(6, hashes.length + 3))} `));
}

/**
 * Neutralize the two tags this renderer uses for its own collapsible sections
 * inside content emitted as raw Markdown (message prose, todos, file paths).
 * Conversation text legitimately discusses `<details>`; leaving it raw would
 * break the exported document's own collapsible structure.
 */
function neutralize(text) {
  return mapOutsideFences(text, (line) => line.replace(/<(\/?)(details|summary)\b/gi, '&lt;$1$2'));
}

/** Escape one fence marker so it renders literally instead of opening a block. */
function escapeFenceMarker(line) {
  return line.replace(/^(\s*)(`{3,}|~{3,})/, (_match, pad, marker) => (
    pad + marker.split('').map((char) => `\\${char}`).join('')
  ));
}

/**
 * Keep content fences from swallowing the rest of the document. Balanced code
 * blocks stay intact — prose legitimately contains them — while an opener with
 * no matching closer is escaped so it renders as literal backticks. This is
 * what stops a truncated or half-written code block in a message from eating
 * every following turn.
 */
function balanceFences(text) {
  const lines = String(text ?? '').split('\n');
  const stack = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = fenceMarkerOf(lines[index]);
    if (marker === undefined) continue;
    const top = stack[stack.length - 1];
    if (top !== undefined && top.char === marker.char && marker.length >= top.length && marker.closes) stack.pop();
    else if (top === undefined) stack.push({ ...marker, line: index });
  }
  if (stack.length === 0) return lines.join('\n');
  const unclosed = new Set(stack.map((entry) => entry.line));
  return lines.map((line, index) => (unclosed.has(index) ? escapeFenceMarker(line) : line)).join('\n');
}

/**
 * Prepare content that is emitted as raw Markdown: clip to the caller's bound,
 * nest its headings under the message heading, neutralize structural tags and
 * balance stray fences.
 */
function rawContent(text, max, what) {
  return balanceFences(neutralize(demoteHeadings(clip(text, max, what))));
}

/* ── content-block projection ────────────────────────────────────────────── */

/** Plain text of one attachment reference, honest about the binary staying out. */
function attachmentLine(block) {
  const attachment = block?.attachment ?? {};
  const name = attachment.name ?? attachment.attachmentId ?? '附件';
  const kind = String(attachment.mediaType ?? '').startsWith('image/') ? '图片' : '文件';
  const size = formatBytes(attachment.bytes);
  const dims = attachment.width && attachment.height ? `，${attachment.width}×${attachment.height}` : '';
  const id = attachment.attachmentId === undefined ? '' : `（${attachment.attachmentId}）`;
  return `📎 ${kind}：${name}${size === '' ? '' : `，${size}`}${dims}${id}`;
}

/**
 * Flatten message content blocks to text.
 * Handles `text`, nested `tool-result`, `image`/`file` attachments, and the
 * `reasoning` / `tool-call` blocks the caller projects separately.
 */
function blocksToText(blocks, options, depth = 0) {
  if (!Array.isArray(blocks)) return '';
  if (depth > 6) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') {
      if (typeof block === 'string') parts.push(block);
      continue;
    }
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '');
        break;
      case 'reasoning':
        parts.push(block.text ?? '');
        break;
      case 'tool-result':
        parts.push(blocksToText(block.content, options, depth + 1));
        break;
      case 'image':
      case 'file':
        parts.push(attachmentLine(block));
        break;
      default:
        if (typeof block.text === 'string') parts.push(block.text);
        break;
    }
  }
  return parts.filter((part) => part !== '').join('\n\n');
}

/** Extract the reasoning text of one assistant message. */
function reasoningText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/** Extract the visible prose of one assistant message. */
function assistantProse(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/** Tool-call blocks carried by an assistant message, in order. */
function toolCallsOf(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block) => block?.type === 'tool-call' && typeof block.name === 'string');
}

/* ── rendering helpers ───────────────────────────────────────────────────── */

/** Short argument-derived hint used in a collapsed tool summary. */
function toolHint(name, rawArguments) {
  let parsed;
  try {
    parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
  } catch {
    return inline(rawArguments, 70);
  }
  if (parsed === null || typeof parsed !== 'object') return inline(rawArguments, 70);
  for (const key of ['description', 'query', 'command', 'file_path', 'path', 'pattern', 'subject', 'message']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return inline(value, 70);
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return '';
  return inline(keys.map((key) => `${key}=${JSON.stringify(parsed[key])}`).join(' '), 70);
}

/** Collapsible section; `body` is markdown emitted verbatim. */
function details(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** `- [x] done` checklist from a todo/write payload. */
function todoList(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '';
  return todos
    .map((todo) => `- [${todo?.status === 'completed' ? 'x' : ' '}] ${neutralize(inline(todo?.content ?? '', 200))}`)
    .join('\n');
}

/* ── renderer ────────────────────────────────────────────────────────────── */

/**
 * Render one session to Markdown.
 * @param {object} input
 * @param {object} [input.header] - session header (`id`, `createdAt`, `cwd`, `origin`, …).
 * @param {readonly object[]} [input.events] - session events in log order.
 * @param {object} [input.options] - {@link DEFAULT_OPTIONS} overrides.
 * @param {string} [input.title] - pre-resolved title, overriding in-log titles.
 * @param {string} [input.exportedAt] - ISO timestamp of the export itself.
 * @returns {string} Markdown document.
 */
export function renderSession({ header, events, options, title, exportedAt } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const turns = new Map();
  const turnOrder = [];
  const calls = new Map();
  const renderedResults = new Set();
  const pendingCalls = new Set();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0 };
  let model;
  let systemPrompt;
  let currentTurn = 0;
  let interrupted = false;

  const bucket = (turn) => {
    const key = Number.isFinite(turn) ? turn : currentTurn;
    if (!turns.has(key)) {
      turns.set(key, []);
      turnOrder.push(key);
    }
    return turns.get(key);
  };

  for (const event of events ?? []) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;
    if (!RENDERED_TYPES.has(type)) continue;
    const data = event.data ?? {};
    const turn = Number.isFinite(data.turn) ? data.turn : currentTurn;
    currentTurn = turn;

    switch (type) {
      case 'user/message': {
        const kind = data.source?.kind ?? 'user';
        const text = blocksToText(data.content, opts);
        if (text.trim() === '') break;
        if (kind === 'user') {
          bucket(turn).push({ kind: 'user', text: rawContent(text, opts.maxTextChars, '消息') });
        } else if (COLLAB_KINDS.has(kind)) {
          bucket(turn).push({ kind: 'collab', label: kind, text: rawContent(text, opts.maxTextChars, '消息') });
        } else if (opts.includeInjectedContext) {
          bucket(turn).push({ kind: 'injected', label: kind, text: rawContent(text, opts.maxTextChars, '上下文') });
        }
        break;
      }

      case 'system/message':
      case 'developer/message': {
        const kind = data.message?.source?.kind ?? 'system';
        const text = blocksToText(data.message?.content, opts);
        if (text.trim() === '') break;
        if (kind === 'system-prompt' || kind === 'system') {
          if (opts.includeSystemPrompt) bucket(turn).push({ kind: 'system', label: kind, text: rawContent(text, opts.maxTextChars, '系统消息') });
        } else if (opts.includeInjectedContext) {
          bucket(turn).push({ kind: 'injected', label: kind, text: rawContent(text, opts.maxTextChars, '上下文') });
        }
        break;
      }

      case 'assistant/message': {
        const blocks = data.message?.content;
        if (data.usage) {
          usage.input += data.usage.inputTokens ?? 0;
          usage.output += data.usage.outputTokens ?? 0;
          usage.cacheRead += data.usage.cacheReadTokens ?? 0;
          usage.cacheWrite += data.usage.cacheWriteTokens ?? 0;
          usage.total += data.usage.totalTokens ?? 0;
          usage.steps += 1;
        }
        if (data.message?.source?.model !== undefined && data.message?.source?.provider !== undefined) {
          model = `${data.message.source.provider}/${data.message.source.model}`;
        }
        if (data.interrupted === true) interrupted = true;
        const reasoning = opts.includeReasoning ? reasoningText(blocks) : '';
        if (reasoning !== '') {
          bucket(turn).push({
            kind: 'reasoning',
            text: rawContent(reasoning, opts.maxReasoningChars, '思考过程'),
          });
        }
        const prose = assistantProse(blocks);
        if (prose !== '') {
          bucket(turn).push({ kind: 'assistant', text: rawContent(prose, opts.maxTextChars, '回复') });
        }
        for (const call of toolCallsOf(blocks)) {
          if (typeof call.id === 'string' && !calls.has(call.id)) calls.set(call.id, { name: call.name, arguments: call.arguments, turn });
        }
        break;
      }

      case 'tool/call': {
        if (typeof data.callId === 'string') {
          calls.set(data.callId, { name: data.name, arguments: data.arguments, turn, step: data.step });
          pendingCalls.add(data.callId);
        }
        break;
      }

      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId ?? `result-${event.seq ?? ''}`;
        const call = calls.get(callId) ?? {};
        renderedResults.add(callId);
        pendingCalls.delete(callId);
        const errorCode = data.error?.code ?? data.error?.name;
        const isError = Boolean(data.error) || data.message?.content?.some((block) => block?.isError === true) === true;
        const text = blocksToText(data.message?.content, opts).trim();
        bucket(turn).push({
          kind: 'tool',
          name: call.name ?? data.message?.source?.name ?? '工具',
          arguments: call.arguments,
          hint: toolHint(call.name, call.arguments),
          text: clip(text, opts.maxToolResultChars, '工具结果'),
          isError,
          errorCode,
        });
        break;
      }

      case 'todo/write': {
        const list = todoList(data.todos);
        if (list !== '') bucket(turn).push({ kind: 'todo', text: list });
        break;
      }

      case 'compaction/summary': {
        const text = blocksToText(data.summary, opts);
        if (text.trim() === '') break;
        const tokens = data.shadowedTokenCount;
        const label = Number.isFinite(tokens) ? `🗜️ 上下文压缩摘要（压缩前 ≈${tokens.toLocaleString('en-US')} tokens）` : '🗜️ 上下文压缩摘要';
        bucket(turn).push({ kind: 'compaction', label, text: rawContent(text, opts.maxTextChars, '压缩摘要') });
        break;
      }

      case 'deliverables/presented': {
        const files = Array.isArray(data.files) ? data.files : [];
        if (files.length === 0) break;
        const body = files
          .map((file) => {
            const path = typeof file === 'string' ? file : file?.path;
            const description = typeof file === 'object' && file !== null ? file.description : undefined;
            return neutralize(`- \`${path ?? '?'}\`${description ? ` — ${inline(description, 120)}` : ''}`);
          })
          .join('\n');
        bucket(turn).push({ kind: 'deliverables', text: body });
        break;
      }

      default:
        break;
    }
  }

  // Resolve the model and the system prompt from the log.
  for (const event of events ?? []) {
    if (event?.type === 'request/header') {
      const headerData = event.data?.header;
      if (typeof headerData?.system === 'string' && headerData.system.trim() !== '') systemPrompt = headerData.system;
      const config = headerData?.config;
      if (model === undefined && config?.provider !== undefined && config?.model !== undefined) {
        model = `${config.provider}/${config.model}`;
      }
    }
  }

  /* ── document assembly ─────────────────────────────────────────────────── */

  const id = header?.id ?? 'unknown';
  const docTitle = title === undefined ? deriveDocumentTitle(header, events) : neutralize(title);

  const meta = [];
  meta.push(`| 会话 | \`${id}\` |`);
  if (header?.createdAt !== undefined) meta.push(`| 创建时间 | ${formatTime(header.createdAt, opts.timeZone)} |`);
  if (model !== undefined) meta.push(`| 模型 | \`${model}\` |`);
  if (typeof header?.cwd === 'string') meta.push(`| 工作目录 | \`${header.cwd}\` |`);
  if (header?.origin === 'subagent') {
    const depth = header?.delegationDepth === undefined ? '' : `，深度 ${header.delegationDepth}`;
    const parent = header?.parentSession === undefined ? '' : `，父会话 \`${header.parentSession}\``;
    meta.push(`| 来源 | 子代理${depth}${parent} |`);
  }
  if (header?.agentPreset !== undefined) meta.push(`| 预设 | \`${header.agentPreset}\` |`);
  const turnCount = turnOrder.filter((turn) => turns.get(turn).some((block) => block.kind === 'user')).length;
  meta.push(`| 规模 | ${turnCount} 轮 · ${(events?.length ?? 0).toLocaleString('en-US')} 事件 |`);
  if (usage.total > 0) {
    meta.push(
      `| 用量 | 输入 ${usage.input.toLocaleString('en-US')} · 输出 ${usage.output.toLocaleString('en-US')}`
        + `${usage.cacheRead > 0 ? ` · 缓存命中 ${usage.cacheRead.toLocaleString('en-US')}` : ''}`
        + ` · 合计 ${usage.total.toLocaleString('en-US')} tokens（${usage.steps} 次模型调用，按事件累计） |`,
    );
  }
  if (exportedAt !== undefined) meta.push(`| 导出时间 | ${exportedAt} |`);

  // A GFM table needs a header row and a delimiter; without the delimiter the
  // rows render as literal pipes in every Markdown viewer, not just in HTML.
  const out = [`# ${docTitle}`, '', '| 项目 | 内容 |', '| --- | --- |', meta.join('\n')];

  if (opts.includeSystemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim() !== '') {
    out.push('', details('🧾 系统提示词（System Prompt）', codeBlock(clip(systemPrompt, 20000, '系统提示词'), 'text')));
  }

  const turnLabel = (turn) => (turn === 0 ? '开场（未计入轮次）' : `Turn ${turn}`);

  for (const turn of turnOrder) {
    const blocks = turns.get(turn);
    if (blocks.length === 0) continue;
    const rendered = [];
    /** One share-mode bullet for a tool call. */
    const toolBullet = (block) => neutralize(`- ${block.isError ? '❌' : '🔧'} \`${inline(block.name, 60)}\`${block.hint === '' ? '' : ` · ${block.hint}`}`);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.kind === 'tool' && !opts.includeToolDetails) {
        const bullets = [];
        while (index < blocks.length && blocks[index].kind === 'tool' && !opts.includeToolDetails) {
          bullets.push(toolBullet(blocks[index]));
          index += 1;
        }
        index -= 1;
        rendered.push(bullets.join('\n'));
        continue;
      }
      switch (block.kind) {
        case 'user':
          rendered.push(`### 👤 用户\n\n${block.text}`);
          break;
        case 'collab':
          rendered.push(`### 🤝 协作消息（${block.label}）\n\n${block.text}`);
          break;
        case 'injected':
          rendered.push(details(`⚙️ 注入上下文：${block.label}`, block.text));
          break;
        case 'system':
          rendered.push(details(`🧾 系统消息：${block.label}`, block.text));
          break;
        case 'assistant':
          rendered.push(`### 🤖 助手\n\n${block.text}`);
          break;
        case 'reasoning':
          rendered.push(details('🧠 思考过程', block.text));
          break;
        case 'tool': {
          const name = `\`${inline(block.name, 60)}\``;
          const hint = block.hint === '' ? '' : ` · ${block.hint}`;
          const mark = block.isError ? '❌' : '🔧';
          if (!opts.includeToolDetails) {
            rendered.push(toolBullet(block));
            break;
          }
          const body = [];
          if (block.arguments !== undefined) {
            body.push('**参数**', '', codeBlock(clip(block.arguments, opts.maxToolArgChars, '工具参数'), 'json'));
          }
          if (block.text !== '') {
            body.push('', `**结果**${block.isError ? `（错误${block.errorCode === undefined ? '' : ` ${block.errorCode}`}）` : ''}`, '', codeBlock(block.text, 'text'));
          } else if (block.isError) {
            body.push('', `**结果**：错误${block.errorCode === undefined ? '' : `（${block.errorCode}）`}`);
          }
          rendered.push(details(neutralize(`${mark} 工具调用：${name}${hint}`), body.join('\n')));
          break;
        }
        case 'todo':
          rendered.push(details('📝 待办清单', block.text));
          break;
        case 'compaction':
          rendered.push(details(block.label, block.text));
          break;
        case 'deliverables':
          rendered.push(`📦 交付文件：\n\n${block.text}`);
          break;
        default:
          break;
      }
    }
    if (rendered.length > 0) out.push('', `## ${turnLabel(turn)}`, '', rendered.join('\n\n'));
  }

  // Tool calls the model made that never produced a result (interrupt, crash).
  const orphaned = [];
  for (const callId of pendingCalls) {
    if (renderedResults.has(callId)) continue;
    const call = calls.get(callId);
    if (call === undefined) continue;
    orphaned.push(`- \`${call.name}\`${call.arguments === undefined ? '' : ` · ${toolHint(call.name, call.arguments)}`}（未返回结果）`);
  }
  if (orphaned.length > 0) {
    out.push('', '## 未完成的工具调用', '', orphaned.join('\n'));
  }

  if (interrupted) out.push('', '> ⚠️ 本会话中存在被中断的回复，日志可能缺少对应的工具结果。');
  out.push('');
  return out.join('\n');
}

/**
 * Human title of one session: the logged `session/title`, else the first human
 * message, else the session id. Shared by the document renderer and the
 * browser-download route, which names the downloaded file after it.
 * @param {object} [header] - session header.
 * @param {readonly object[]} [events] - session events.
 * @returns {string} Title text, safe to embed in Markdown.
 */
export function deriveDocumentTitle(header, events) {
  let logTitle;
  let firstUser;
  for (const event of events ?? []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      logTitle = event.data.title.trim();
    } else if (firstUser === undefined && event?.type === 'user/message' && (event.data?.source?.kind ?? 'user') === 'user') {
      const text = blocksToText(event.data.content, DEFAULT_OPTIONS);
      if (text.trim() !== '') firstUser = text;
    }
  }
  const fallback = `会话 ${header?.id ?? 'unknown'}`;
  return neutralize(logTitle ?? (firstUser === undefined ? fallback : inline(firstUser.split('\n')[0], 60)));
}

/** Windows device names that can never be used as a file stem. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Derive a file-name-safe slug from an arbitrary title.
 *
 * Safe on every platform: Windows forbids `\ / : * ? " < > |`, control
 * characters, names ending in a dot or space, and the reserved device names
 * (`CON`, `NUL`, `COM1`, …) — a session titled "con" must not produce an
 * unwritable `con.md`.
 * @param {string} title - raw title text.
 * @param {number} [maxLength] - maximum slug length.
 * @returns {string} slug safe to use as a file stem.
 */
export function slugify(title, maxLength = 40) {
  const flat = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  const sized = (flat.length > maxLength ? flat.slice(0, maxLength) : flat).replace(/[. ]+$/g, '');
  if (sized === '') return 'session';
  // Windows reserves the device names even with an extension: `CON.txt` is as
  // unwritable as `CON`, so test the part before the first dot.
  const base = sized.split('.')[0];
  return WINDOWS_DEVICE_NAMES.test(base) ? `_${sized}` : sized;
}
