#!/usr/bin/env node
/**
 * Offline dumper: render a stored session log to Markdown without booting DSH.
 *
 *   node scripts/dump.mjs                        # newest session, to stdout
 *   node scripts/dump.mjs --out out.md           # newest session, to a file
 *   node scripts/dump.mjs --session <id>         # by session id (substring ok)
 *   node scripts/dump.mjs --file <log.jsonl.zstd>
 *   node scripts/dump.mjs --clean                # share version: tool names only
 *   node scripts/dump.mjs --list                 # list recent sessions
 *
 * Inside DSH the same rendering is available to the model as the
 * `export_session_md` tool; this script is the offline verification path.
 */

import { writeFileSync } from 'node:fs';
import { formatTime, renderSession } from '../lib/render.mjs';
import { listSessions, readSessionFile } from './read-log.mjs';

/** Minimal `--flag value` parser. */
function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sessions = listSessions(args.root);

if (args.list === true) {
  for (const session of sessions.slice(0, 25)) {
    console.log(`${new Date(session.mtimeMs).toISOString()}  ${session.id}  ${session.file}`);
  }
  process.exit(0);
}

let source;
if (typeof args.file === 'string') {
  source = { id: args.file, file: args.file };
} else if (typeof args.session === 'string') {
  source = sessions.find((session) => session.id.includes(args.session));
} else {
  source = sessions[0];
}
if (source === undefined) {
  console.error('no session found; pass --file <log> or --session <id>, or check --root');
  process.exit(1);
}

const { header, events } = readSessionFile(source.file);
const markdown = renderSession({
  header,
  events,
  options: args.clean === true
    ? { includeToolDetails: false, includeReasoning: false, includeInjectedContext: false }
    : {},
  exportedAt: formatTime(Date.now()),
});

if (typeof args.out === 'string') {
  writeFileSync(args.out, markdown, 'utf8');
  console.log(`${source.id} → ${args.out} (${(Buffer.byteLength(markdown) / 1024).toFixed(1)} KB, ${events.length} events)`);
} else {
  process.stdout.write(markdown);
}
