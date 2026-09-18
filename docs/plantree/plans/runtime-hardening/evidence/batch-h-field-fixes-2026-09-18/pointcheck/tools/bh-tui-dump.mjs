#!/usr/bin/env node
/**
 * bh-tui-dump.mjs — read back the pty transcript bh-tui.mjs parked on `window.__bhTui`.
 *
 * Split out of an inline `bh-cdp.mjs eval` because the ANSI-stripping regexes need
 * literal escape characters, and a shell one-liner carrying raw control bytes is
 * rejected before it ever reaches the app.
 *
 * Usage: node bh-tui-dump.mjs [outFile]   (prints to stdout when no file is given)
 */
import fs from 'node:fs';
import { connect } from './bh-cdp.mjs';

const out = process.argv[2] ?? null;
const cdp = await connect();
try {
  const raw = await cdp.evaluate('(() => window.__bhTui ? window.__bhTui.data : "")()');
  const clean = String(raw)
    // CSI sequences (colour, cursor moves, erases)
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences (hyperlinks, titles, shell integration marks)
    .replace(/\][^]*(?:|\\)/g, '')
    // charset selection and single-char escapes
    .replace(/[()][B0]/g, '')
    .replace(/[=><]/g, '')
    .replace(/\r/g, '\n');
  if (out) {
    fs.writeFileSync(out, clean);
    console.log(`${out}: ${clean.length} chars`);
  } else {
    console.log(clean);
  }
} finally {
  cdp.close();
}
