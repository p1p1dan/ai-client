#!/usr/bin/env node
/**
 * effort-log.mjs — R4: read ONE field from a DSH session log.
 *
 *   node effort-log.mjs [--types] <aiclient session id> [...more ids]
 *
 * Decompresses `<DSH_HOME>/sessions/<cwd>/aiclient-<id>/session.v4.jsonl.zstd`
 * and, for every `request/header` event, prints its sequence number, its
 * `reason` (a DSH enum: initial / resume / change / series) and
 * `header.config.reasoningEffort`. Nothing else from the log is printed: the
 * header can carry request-header fragments, so every other field is left
 * unread by design. A value that is not a short effort word is replaced by
 * `(unexpected shape)` rather than shown. `--types` adds a count of event
 * type names (DSH enums such as `model-selection`), nothing else.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DSH_HOME = '/tmp/aiclient-real-gw/home/.pilab/jyw-ai-client-dev/dsh-home';
const EFFORT_WORD = /^(off|none|minimal|low|medium|high|xhigh|max)$/;
const REASONS = new Set(['initial', 'resume', 'change', 'series']);

function logFileFor(sessionId) {
  const root = path.join(DSH_HOME, 'sessions');
  for (const cwdDir of fs.readdirSync(root)) {
    const file = path.join(root, cwdDir, `aiclient-${sessionId}`, 'session.v4.jsonl.zstd');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function efforts(sessionId) {
  const file = logFileFor(sessionId);
  if (!file) return { sessionId, error: 'no log' };
  const text = execFileSync('zstd', ['-dcq', file], { maxBuffer: 64 * 1024 * 1024 }).toString(
    'utf8'
  );
  const rows = [];
  const types = {};
  for (const line of text.split('\n')) {
    if (withTypes) {
      // Event type names only (DSH enums), counted.
      const m =
        /^\{"type":"([a-z0-9/_-]{1,40})"/.exec(line) ??
        /"type":"([a-z0-9/_-]{1,40})"/.exec(line.slice(0, 200));
      if (m) types[m[1]] = (types[m[1]] ?? 0) + 1;
    }
    if (!line.includes('request/header')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'request/header') continue;
    const value = event?.data?.header?.config?.reasoningEffort;
    const reason = event?.data?.reason;
    rows.push({
      seq: typeof event.seq === 'number' ? event.seq : null,
      reason: REASONS.has(reason) ? reason : '(other)',
      reasoningEffort:
        value === undefined
          ? '(absent)'
          : typeof value === 'string' && EFFORT_WORD.test(value)
            ? value
            : '(unexpected shape)',
    });
  }
  return withTypes ? { sessionId, headers: rows, types } : { sessionId, headers: rows };
}

const withTypes = process.argv.includes('--types');
const ids = process.argv.slice(2).filter((a) => a !== '--types');
if (!ids.length) {
  console.error('usage: effort-log.mjs <session id> [...]');
  process.exit(2);
}
for (const id of ids) console.log(JSON.stringify(efforts(id)));
