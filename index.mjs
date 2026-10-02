/**
 * dsh-session-md — host half.
 *
 * Registers one model-facing tool, `export_session_md`, that renders a session
 * (this one, a named one, or every session) into a human-readable Markdown
 * document and writes it to disk. The built-in `@deepseek-ai/dsh-session-log-export`
 * only ships the raw JSONL log as a browser ZIP; this plugin is the "one clean
 * document per conversation" companion.
 *
 * Design notes:
 *   - Session bodies come from public services (`ctx.sessions` for live
 *     sessions, `ctx.sessionPersistence` for stored ones), never from files, so
 *     the plugin stays independent of the physical log format.
 *   - Writes go through `ctx.fs` with the calling session's own sandbox policy,
 *     so an export cannot land outside the boundary the user configured.
 *   - Export shape matters: this module must NOT have a default export. The
 *     Cordis loader normalizes a module with `exports.default ?? exports`, so a
 *     default export replaces the plugin object and silently drops `name` and
 *     `inject`; the plugin then dies with `cannot get property "tools" without
 *     inject`. DSH packages export named bindings only.
 *   - Dependencies are declared: Cordis throws on any `ctx.<service>` read that
 *     `inject` does not cover, so only `ctx.get(name)` may reach a service that
 *     is genuinely optional (here: the sandbox policy).
 *   - No `@deepseek-ai/*` import and no `peerDependencies`, so the DSH plugin
 *     compatibility gate has nothing to refuse.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { markdownToHtml } from './lib/html.mjs';
import { DEFAULT_OPTIONS, MODE_NAMES, deriveDocumentTitle, formatTime, optionsForMode, renderSession, slugify } from './lib/render.mjs';

export const name = 'session-md';

/** Services this plugin reads; all four ship in `@deepseek-ai/dsh-base`. */
export const inject = ['tools', 'sessions', 'sessionPersistence', 'fs'];

/** Tool name; distinct from third-party `export_session` so both can coexist. */
const TOOL_NAME = 'export_session_md';

/** Authenticated download route behind the Session Header button. */
const EXPORT_ROUTE_PATH = '/api/session.export-md';

/** Hard ceiling per document, so one runaway session cannot fill the disk. */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/* ── argument handling ───────────────────────────────────────────────────── */

/** Read one optional boolean with a default. */
function booleanArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`);
  return value;
}

/** Read one optional non-negative integer with a default. */
function integerArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`参数 ${key} 必须是非负整数`);
  }
  return value;
}

/** Read one optional string with a default. */
function stringArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  return value;
}

/** Normalize model-supplied arguments into renderer options. */
/** Output formats the tool and the download route accept. */
const FORMATS = Object.freeze(['md', 'html']);

/** Preset names the tool accepts: the four renderer presets plus `both`. */
const TOOL_MODES = Object.freeze([...MODE_NAMES, 'both'].filter((mode, index, all) => all.indexOf(mode) === index));

/** Names of every option a caller may override on top of a preset. */
const BOOLEAN_OPTIONS = ['includeToolDetails', 'includeReasoning', 'includeSystemPrompt', 'includeInjectedContext'];
const INTEGER_OPTIONS = ['maxToolArgChars', 'maxToolResultChars', 'maxReasoningChars', 'maxTextChars'];

/**
 * Resolve the requested mode plus any explicit overrides.
 * Explicitly-passed options always win, so `mode: 'readable'` can still be
 * asked for detailed tool output (`includeToolDetails: true`).
 * @param {object} args - model-supplied tool arguments.
 * @returns {{mode: string, options: object, writes: string[]}} resolved plan.
 */
function planForArgs(args) {
  const mode = stringArg(args, 'mode', 'full');
  if (!TOOL_MODES.includes(mode)) {
    throw new Error(`参数 mode 必须是 ${TOOL_MODES.join(' / ')} 之一，收到 "${mode}"`);
  }
  const format = stringArg(args, 'format', 'md');
  if (!FORMATS.includes(format)) {
    throw new Error(`参数 format 必须是 ${FORMATS.join(' / ')} 之一，收到 "${format}"`);
  }
  const overrides = {};
  for (const key of BOOLEAN_OPTIONS) overrides[key] = booleanArg(args, key, undefined);
  for (const key of INTEGER_OPTIONS) overrides[key] = integerArg(args, key, undefined);
  if (mode === 'both') {
    return {
      mode,
      format,
      writes: ['full', 'readable'],
      options: optionsForMode('full', overrides),
      optionsByKind: { full: optionsForMode('full', overrides), readable: optionsForMode('readable', overrides) },
    };
  }
  return {
    mode,
    format,
    writes: [mode],
    options: optionsForMode(mode, overrides),
    optionsByKind: { [mode]: optionsForMode(mode, overrides) },
  };
}

/* ── session access ──────────────────────────────────────────────────────── */

/** The calling agent's live Session, when the call came from an agent loop. */
function callerSession(exec) {
  return exec?.agent?.session;
}

/** Session id of the agent running this tool call, when the caller is an agent. */
function callerSessionId(exec) {
  const id = exec?.agent?.sessionId;
  if (typeof id === 'string') return id;
  const sessionId = exec?.agent?.session?.id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Resolve `{ header, events }` for one session id from live memory first, then
 * from durable storage. Live sessions are flushed first so the document
 * includes events appended moments ago (including this very tool call).
 */
async function readSession(ctx, id, signal) {
  const live = ctx.sessions.get(id);
  if (live !== undefined) {
    try {
      await ctx.sessions.flush(live);
    } catch {
      // Durability belongs to persistence; the in-memory snapshot below is still authoritative.
    }
    return { header: live.header, events: live.snapshotEvents() };
  }
  const handle = await ctx.sessionPersistence.open(id, 'read', signal === undefined ? {} : { signal });
  try {
    const result = await handle.read(undefined, undefined, signal === undefined ? {} : { signal });
    return { header: handle.header, events: result.events };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Every known session header: live memory plus durable storage, deduplicated. */
async function listSessionHeaders(ctx, signal) {
  const headers = new Map();
  for (const session of ctx.sessions.list()) {
    headers.set(session.header.id, session.header);
  }
  try {
    const snapshots = (await ctx.sessionPersistence.list(signal === undefined ? {} : { signal })) ?? [];
    for (const snapshot of snapshots) {
      if (!headers.has(snapshot.header.id)) headers.set(snapshot.header.id, snapshot.header);
    }
  } catch {
    // A persistence listing failure still leaves the live sessions usable.
  }
  return headers;
}

/** Breadth-first descendants of one session, parents before children. */
function collectDescendants(rootId, headers) {
  const children = new Map();
  for (const header of headers.values()) {
    const parent = header.parentSession;
    if (typeof parent !== 'string') continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(header);
  }
  const out = [];
  const queue = [...(children.get(rootId) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const seen = new Set([rootId]);
  while (queue.length > 0) {
    const header = queue.shift();
    if (seen.has(header.id)) continue;
    seen.add(header.id);
    out.push(header);
    queue.push(...(children.get(header.id) ?? []));
  }
  return out;
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Sandbox policy for this call: the calling session's own mode and boundary.
 * Read through `ctx.get` because the sandbox-policy service is an optional
 * capability — a profile without it writes under the backend's own default.
 */
function sandboxPolicyFor(ctx, exec) {
  const service = ctx.get('sandboxPolicy');
  if (service === undefined || typeof service.resolve !== 'function') return undefined;
  try {
    const session = callerSession(exec);
    return session === undefined ? service.resolve() : service.resolve({ session });
  } catch {
    return undefined;
  }
}

/**
 * Write one UTF-8 file through the profile filesystem service. The explicit
 * write intent keeps the write race-safe and consistent with the
 * read-before-write policy: an existing file is replaced at its observed
 * version, a new one is created without clobbering a concurrent creator.
 */
async function writeDocument(ctx, exec, absolutePath, content) {
  const target = await ctx.fs.resolve(absolutePath, { signal: exec?.signal });
  const info = await ctx.fs.stat(target, exec?.signal).catch(() => undefined);
  if (info !== undefined && info.type !== 'file') {
    throw new Error(`无法写入 ${absolutePath}：目标已存在且不是普通文件`);
  }
  const intent = info === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: info.version };
  const outcome = await ctx.fs.writeText(target, content, intent, exec?.signal, sandboxPolicyFor(ctx, exec));
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
  return target.displayPath ?? absolutePath;
}

/** Directory that receives the documents of one export run. */
function outputDirectory(rawPath, cwd) {
  if (rawPath === undefined || rawPath === '') return cwd;
  const base = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  if (/\.md$/i.test(base)) throw new Error('all:true 一次导出多个会话，path 只能是目录，不能是 .md 文件');
  return base;
}

/* ── browser download route ──────────────────────────────────────────────── */

/** Headers for one Markdown download, including a UTF-8-safe filename. */
function downloadHeaders(filename, format = 'md') {
  const stem = slugify(filename.replace(/\.(md|html)$/i, ''), 40).replace(/[^A-Za-z0-9._-]/g, '-') || 'export';
  const ascii = `session-${stem}.${format}`;
  return {
    'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
  };
}

/**
 * Serve one session as a Markdown download.
 *
 * Query: `sessionId` (required), plus the share switches the tool exposes —
 * `clean=1` (tool names only), `reasoning=0`, `system=1`, `injected=1`.
 * `HEAD` answers with the same headers and no body, so the browser can preflight.
 */
async function markdownResponse(ctx, request) {
  const url = new URL(request.url);
  const query = url.searchParams;
  const sessionId = query.get('sessionId');
  if (sessionId === null || sessionId === '') {
    return new Response('missing sessionId query parameter', { status: 400 });
  }
  // Validate input before touching storage, so a bad request is a 400 even when
  // the session id is unknown. `both` is a tool concept (two files); a download
  // carries exactly one document and degrades to `full`.
  const requested = query.get('mode') ?? 'full';
  const mode = requested === 'both' ? 'full' : requested;
  if (!MODE_NAMES.includes(mode)) {
    return new Response(`unknown mode "${requested}"; expected one of ${MODE_NAMES.join(', ')} or both`, { status: 400 });
  }
  const format = query.get('format') ?? 'md';
  if (!FORMATS.includes(format)) {
    return new Response(`unknown format "${format}"; expected one of ${FORMATS.join(', ')}`, { status: 400 });
  }
  let session;
  try {
    session = await readSession(ctx, sessionId, request.signal);
  } catch {
    return new Response(`session not found: ${sessionId}`, { status: 404 });
  }
  const markdown = renderSession({
    header: session.header,
    events: session.events,
    options: optionsForMode(mode, {
      // Legacy share switches stay supported and override the preset.
      includeToolDetails: query.get('clean') === '1' ? false : undefined,
      includeReasoning: query.get('reasoning') === '0' ? false : undefined,
      includeSystemPrompt: query.get('system') === '1' ? true : undefined,
      includeInjectedContext: query.get('injected') === '1' ? true : undefined,
    }),
    exportedAt: formatTime(Date.now()),
  });
  const filename = `${slugify(deriveDocumentTitle(session.header, session.events), 60)}.${format}`;
  const document = format === 'html' ? markdownToHtml({ markdown }) : markdown;
  const body = request.method === 'HEAD' ? null : document;
  return new Response(body, { status: 200, headers: downloadHeaders(filename, format) });
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

/** Register the export tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Export DeepSeek Harness sessions as Markdown documents written to disk: user messages, assistant replies '
      + 'and reasoning, tool calls with arguments and results, todos, compaction summaries and presented '
      + 'deliverables, grouped by turn. Defaults to the current conversation and to mode "full".\n'
      + 'Modes: full = everything, for another agent to take over or to reproduce a run; handoff = tool calls kept '
      + 'but reasoning dropped and long results truncated, to save tokens; readable = for a human, tool calls kept '
      + 'as names only; audit = nothing truncated, plus the system prompt and injected context; both = write the '
      + 'full and readable documents side by side. Individual options override the chosen mode. '
      + 'Set format "html" for a self-contained page you can share or print to PDF.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: {
          type: 'string',
          enum: ['md', 'html'],
          description:
            'Output format. md = Markdown (default); html = one self-contained HTML file with inline styling, '
            + 'which prints correctly (collapsible sections expand for print, so "print to PDF" keeps them).',
        },
        mode: {
          type: 'string',
          enum: ['full', 'handoff', 'readable', 'audit', 'both'],
          description:
            'Export preset. full = everything (agent handoff / reproduction); handoff = tool calls without '
            + 'reasoning, long results truncated; readable = human-friendly, tool names only; audit = untruncated, '
            + 'including system prompt and injected context; both = write the full and readable files together. '
            + 'Defaults to full.',
        },
        sessionId: {
          type: 'string',
          description: 'Session id to export. Defaults to the current session.',
        },
        all: {
          type: 'boolean',
          description: 'Export every session visible to this process instead of a single one. Defaults to false.',
        },
        path: {
          type: 'string',
          description:
            'Output location. With a single session, a path ending in .md is the exact file; anything else is a '
            + 'directory that receives <sessionId>.md. Defaults to the session working directory.',
        },
        includeSubagents: {
          type: 'boolean',
          description: 'Also export descendant subagent sessions under <sessionId>.subagents/. Defaults to true.',
        },
        includeToolDetails: {
          type: 'boolean',
          description: 'Override the mode: include tool arguments and results (false = tool names only).',
        },
        includeReasoning: {
          type: 'boolean',
          description: 'Override the mode: include assistant reasoning/thinking blocks.',
        },
        includeSystemPrompt: {
          type: 'boolean',
          description: 'Override the mode: include the request system prompt as a collapsed section.',
        },
        includeInjectedContext: {
          type: 'boolean',
          description: 'Override the mode: include machine-injected user-role context (time, runtime, skills, memory, plugin context).',
        },
        maxToolResultChars: {
          type: 'integer',
          description: 'Maximum characters kept per tool result before truncation. Defaults to 4000.',
        },
        maxToolArgChars: {
          type: 'integer',
          description: 'Maximum characters kept per tool argument payload. Defaults to 1200.',
        },
        maxReasoningChars: {
          type: 'integer',
          description: 'Maximum characters kept per reasoning block. Defaults to 8000.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths written.' },
          count: { type: 'integer', description: 'Number of documents written.' },
          bytes: { type: 'integer', description: 'Total document bytes written.' },
        },
        required: ['files', 'count', 'bytes'],
      },
      render(_args, value) {
        const files = Array.isArray(value?.files) ? value.files : [];
        const size = typeof value?.bytes === 'number' ? `（${(value.bytes / 1024).toFixed(1)} KB）` : '';
        return [{
          type: 'text',
          text: `已导出 ${value?.count ?? files.length} 份 Markdown 文档${size}：\n${files.map((file) => `- ${file}`).join('\n')}`,
        }];
      },
    },

    async execute(args, exec) {
      const plan = planForArgs(args);
      const all = booleanArg(args, 'all', false);
      const includeSubagents = booleanArg(args, 'includeSubagents', true);
      const requestedPath = stringArg(args, 'path', undefined);
      const requestedId = stringArg(args, 'sessionId', undefined);

      const headers = await listSessionHeaders(ctx, exec.signal);
      const cwd = callerSession(exec)?.header?.cwd ?? process.cwd();

      let roots;
      if (all) {
        const ids = new Set(headers.keys());
        roots = [...headers.values()].filter((header) => {
          const parent = header.parentSession;
          return typeof parent !== 'string' || !ids.has(parent);
        });
        if (roots.length === 0) {
          throw new Error('没有找到任何可导出的会话');
        }
      } else {
        const id = requestedId ?? callerSessionId(exec);
        if (id === undefined) {
          throw new Error('无法确定要导出的会话：既没有传入 sessionId，这次调用也不来自某个 agent 会话');
        }
        const header = headers.get(id);
        if (header === undefined) {
          throw new Error(`找不到会话 ${id}：它既不活跃，也不在持久化存储中`);
        }
        roots = [header];
      }

      let directory;
      let exactPath;
      if (all) {
        directory = outputDirectory(requestedPath, cwd);
      } else if (requestedPath !== undefined && requestedPath !== '') {
        const base = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath);
        if (/\.md$/i.test(base)) exactPath = base;
        else directory = base;
      }
      const exportedAt = formatTime(Date.now());
      const files = [];
      let bytes = 0;

      for (const root of roots) {
        const work = [[root, false]];
        if (includeSubagents) {
          for (const child of collectDescendants(root.id, headers)) work.push([child, true]);
        }
        for (const [header, isChild] of work) {
          const { header: liveHeader, events } = await readSession(ctx, header.id, exec.signal);
          const sessionDirectory = isChild
            ? join(directory ?? header.cwd ?? cwd, `${slugify(root.id, 60)}.subagents`)
            : (directory ?? header.cwd ?? cwd);
          const baseName = isChild
            ? join(sessionDirectory, `${slugify(header.id, 60)}.md`)
            : (exactPath ?? join(sessionDirectory, `${slugify(header.id, 60)}.md`));
          for (const kind of plan.writes) {
            const markdown = renderSession({
              header: { ...header, ...liveHeader },
              events,
              options: plan.optionsByKind[kind],
              exportedAt,
            });
            const document = plan.format === 'html' ? markdownToHtml({ markdown }) : markdown;
            const size = Buffer.byteLength(document, 'utf8');
            if (size > MAX_DOCUMENT_BYTES) {
              throw new Error(`会话 ${header.id} 的文档超过 ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB；请调小 maxToolResultChars / maxReasoningChars，或关闭 includeReasoning`);
            }
            // The format decides the extension; one mode keeps the plain name,
            // `both` disambiguates by mode suffix.
            const stem = baseName.replace(/\.md$/i, '');
            const filePath = plan.writes.length === 1
              ? `${stem}.${plan.format}`
              : `${stem}.${kind}.${plan.format}`;
            files.push(await writeDocument(ctx, exec, filePath, document));
            bytes += size;
          }
        }
      }

      return { files, count: files.length, bytes };
    },
  });

  // The download route is a Web-surface capability. `ctx.inject` WAITS for the
  // connection service instead of sampling it once at mount: in the real Web
  // profile the server binds, and provides `connection`, after the bundle
  // plugins apply — a one-shot `ctx.get('connection')` check registers nothing
  // there, and the button then 404s. Profiles without a connection (headless)
  // simply never run this callback and keep the model-facing tool.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: EXPORT_ROUTE_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => markdownResponse(ctx, request),
    }), 'session-md: markdown download route');
  });

  ctx.logger?.info?.(`[${name}] registered "${TOOL_NAME}"`);
}
