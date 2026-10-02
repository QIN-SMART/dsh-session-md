/**
 * Offline session-log reader — development and verification only.
 *
 * The plugin itself never touches these files: it reads sessions through the
 * `sessions` / `sessionPersistence` services, which own the physical format.
 * These helpers exist so the renderer can be exercised against real logs, and
 * so `scripts/dump.mjs` can convert a log file without booting DSH.
 *
 * Physical layout (persistence-jsonl):
 *   <DSH_HOME>/sessions/<escaped-cwd>/<session-id>/session[.vN].jsonl.zstd
 * The stream is a sequence of concatenated zstd frames (one per flush batch),
 * so `zlib.zstdDecompressSync` must be applied frame by frame: it stops at the
 * end of the first frame and silently ignores the rest.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

/** Decode a concatenated-frame zstd buffer to UTF-8 text. */
export function decodeZstdFrames(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const { buffer: chunk, engine } = zlib.zstdDecompressSync(buffer.subarray(offset), { info: true });
    const used = engine.bytesWritten;
    if (!used) break;
    parts.push(chunk);
    offset += used;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Parse one logical session log (`.jsonl` or `.jsonl.zstd`) into records. */
export function readSessionFile(filePath) {
  const raw = readFileSync(filePath);
  const text = filePath.endsWith('.zstd') ? decodeZstdFrames(raw) : raw.toString('utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn tail is expected on a live log; the persistence layer drops it too.
    }
  }
  const headerRecord = records.find((record) => record.type === 'session');
  let header = { id: filePath };
  if (headerRecord !== undefined) {
    const { type, ...rest } = headerRecord;
    void type;
    header = rest;
  }
  return { header, events: records.filter((record) => record.type !== 'session') };
}

/** Default session root (`$DSH_HOME/sessions`, falling back to `~/.dsh/sessions`). */
export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/** Every session directory under a sessions root, with its newest log file. */
export function listSessions(root = defaultSessionsRoot()) {
  const found = [];
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(root, workspace.name);
    for (const entry of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionPath = join(workspacePath, entry.name);
      let log;
      try {
        log = readdirSync(sessionPath)
          .filter((name) => /^session(\.[\w.-]+)?\.jsonl(\.zstd)?$/.test(name))
          .map((name) => join(sessionPath, name))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      } catch {
        continue;
      }
      if (log === undefined) continue;
      found.push({ id: entry.name, file: log, workspace: workspace.name, mtimeMs: statSync(log).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
