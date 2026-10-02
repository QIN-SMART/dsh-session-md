#!/usr/bin/env node
/**
 * Corpus sweep: render every stored session on this machine and assert the
 * structural properties a shareable document must have. Semantic expectations
 * live in `render-test.mjs`; this pass catches real-world shapes the fixture
 * does not know about.
 *
 *   node scripts/render-check.mjs [--verbose] [--root <sessions-root>]
 *
 * Checks per session: H1 + metadata table, balanced code fences and
 * `<details>` sections outside fences, well-formed turn headings, honoured
 * option switches, deterministic output, and a per-document time bound.
 */

import { renderSession } from '../lib/render.mjs';
import { listSessions, readSessionFile } from './read-log.mjs';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const rootIndex = argv.indexOf('--root');
const root = rootIndex === -1 ? undefined : argv[rootIndex + 1];

const sessions = listSessions(root);
const failures = [];
let checked = 0;
let skipped = 0;
let totalBytes = 0;
let totalEvents = 0;
let slowest = { id: '', ms: 0 };

/**
 * Split Markdown into text outside fenced code blocks and a fence-balance flag.
 * Structural HTML only matters outside fences, and a fence may be longer than
 * three backticks, so this tracks the opened marker length.
 */
function splitFences(markdown) {
  const outside = [];
  let open = 0;
  for (const line of markdown.split('\n')) {
    const match = /^(`{3,})(.*)$/.exec(line);
    if (match !== null) {
      const [, marker, tail] = match;
      if (open === 0) open = marker.length;
      else if (marker.length >= open && tail.trim() === '') open = 0;
      continue;
    }
    if (open === 0) outside.push(line);
  }
  return { outside: outside.join('\n'), balanced: open === 0 };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

for (const session of sessions) {
  let parsed;
  try {
    parsed = readSessionFile(session.file);
  } catch (error) {
    failures.push(`${session.id}: cannot read log — ${error.message}`);
    continue;
  }
  const { header, events } = parsed;
  if (events.length === 0) {
    skipped += 1;
    continue;
  }
  checked += 1;
  totalEvents += events.length;

  const started = Date.now();
  const markdown = renderSession({ header, events });
  const elapsed = Date.now() - started;
  if (elapsed > slowest.ms) slowest = { id: session.id, ms: elapsed };

  const bytes = Buffer.byteLength(markdown, 'utf8');
  totalBytes += bytes;
  const problems = [];

  const { outside, balanced } = splitFences(markdown);
  if (!markdown.startsWith('# ')) problems.push('missing H1 title');
  if (!/\| 会话 \|/.test(markdown)) problems.push('missing metadata table');
  if (!balanced) problems.push('unbalanced code fence');
  if (count(outside, '<details>') !== count(outside, '</details>')) problems.push('unbalanced <details> outside fences');
  if (count(outside, '<details>') !== count(outside, '<summary>')) problems.push('<details> without <summary>');
  for (const heading of outside.match(/^## .*$/gm) ?? []) {
    if (!/^## (Turn \d+|开场（未计入轮次）|未完成的工具调用)$/.test(heading)) {
      problems.push(`malformed H2 heading: ${heading}`);
    }
  }
  if (renderSession({ header, events }) !== markdown) problems.push('non-deterministic output');

  // Option semantics are asserted precisely in render-test.mjs; here only the
  // structural direction, which holds regardless of what a session contains.
  const clean = renderSession({ header, events, options: { includeToolDetails: false } });
  if (count(clean, '<summary>') > count(markdown, '<summary>')) {
    problems.push('includeToolDetails:false added sections');
  }
  const wide = renderSession({ header, events, options: { includeInjectedContext: true } });
  if (wide.length < markdown.length) problems.push('includeInjectedContext:true shrank the document');
  const bounded = renderSession({ header, events, options: { maxToolResultChars: 200, maxReasoningChars: 200 } });
  if (bounded.length > markdown.length) problems.push('tight character bounds grew the document');

  if (problems.length > 0) failures.push(`${session.id}: ${problems.join('; ')}`);
  else if (verbose) console.log(`ok  ${session.id}  ${(bytes / 1024).toFixed(1)} KB  ${events.length} events  ${elapsed} ms`);
}

console.log('');
console.log(`sessions checked : ${checked}${skipped === 0 ? '' : ` (${skipped} empty skipped)`}`);
console.log(`events rendered  : ${totalEvents.toLocaleString('en-US')}`);
console.log(`markdown produced: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`slowest document : ${slowest.id} (${slowest.ms} ms)`);
console.log(`failures         : ${failures.length}`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
