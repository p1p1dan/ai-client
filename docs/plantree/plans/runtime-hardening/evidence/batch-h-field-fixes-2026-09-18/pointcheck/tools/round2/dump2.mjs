#!/usr/bin/env node
/**
 * dump2.mjs — read back the pty transcript parked on window.__bh2.
 *
 * The ANSI regexes here use explicit : the round-1 tool's OSC pattern
 * (`/\][^]*(?:|\\)/g`) lost its literal ESC/BEL bytes somewhere on the way into
 * the file, which left `[^]*` free to swallow the whole transcript from the
 * first `]` onwards — it reported 17 characters for a 66 KB stream.
 */
import fs from 'node:fs';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const out = process.argv[2] ?? null;
const cdp = await connect();
try {
  const raw = await cdp.evaluate('(() => window.__bh2 ? window.__bh2.data : "")()');
  let clean = String(raw);
  // OSC: ESC ] ... (BEL | ESC \)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI/OSC escape sequences from pty output
  clean = clean.replace(/\][\s\S]*?(?:|\\)/g, '');
  // CSI
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI/OSC escape sequences from pty output
  clean = clean.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
  // charset selection / single-char escapes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI/OSC escape sequences from pty output
  clean = clean.replace(/[()][B0]/g, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI/OSC escape sequences from pty output
  clean = clean.replace(/[=><]/g, '');
  clean = clean.replace(/\r/g, '\n');
  if (out) {
    fs.writeFileSync(out, clean);
    console.log(`${out}: ${clean.length} chars (raw ${String(raw).length})`);
  } else {
    console.log(clean.slice(-3000));
  }
} finally {
  cdp.close();
}
