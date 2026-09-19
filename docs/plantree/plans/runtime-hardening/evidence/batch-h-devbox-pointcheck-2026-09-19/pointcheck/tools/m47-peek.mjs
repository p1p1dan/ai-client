#!/usr/bin/env node
/** Read-only look at the embedded TUI: OSC titles, stripped pty tail, xterm text. */
import { Cdp } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_RE = new RegExp(`${ESC}\\](\\d+);([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, 'g');
const strip = (s) =>
  s
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g'), '')
    .replace(new RegExp(`${ESC}[()][B0]`, 'g'), '')
    .replace(new RegExp(`${ESC}[=>]`, 'g'), '');

const tid = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const tail = Number(process.argv[3] ?? 2500);
const cdp = await Cdp.attach(9222, 60_000);

const order = await cdp.evaluate('JSON.stringify(window.__m47tap?.order ?? null)');
console.log('terminals:', order);
const id = tid ?? JSON.parse(order ?? '[]')?.at(-1)?.id;
const raw = (await cdp.evaluate(`window.__m47tap?.terms?.[${JSON.stringify(id)}] ?? ''`)) ?? '';
console.log(`--- ${id}: ${raw.length} bytes ---`);
console.log('--- OSC ---');
for (let m = OSC_RE.exec(raw); m !== null; m = OSC_RE.exec(raw))
  console.log(m[1], JSON.stringify(m[2]));
console.log('--- stripped tail ---');
console.log(strip(raw).slice(-tail));
console.log('--- xterm screen ---');
console.log(
  await cdp.evaluate(
    `(() => { const r = document.querySelector('.xterm-rows'); return r ? r.innerText.slice(-1800) : null; })()`
  )
);
cdp.close();
setTimeout(() => process.exit(0), 300).unref();
