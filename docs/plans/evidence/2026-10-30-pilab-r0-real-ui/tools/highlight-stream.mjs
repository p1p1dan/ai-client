// PiLab R2 (07.7): stream one long code block through the fake gateway (CC-TEXT
// pieces) and measure how long the renderer's main thread is blocked.
// node highlight-stream.mjs <lang|none> <lines> <linesPerPiece> <pieceMs>
// Needs the app on CDP 9222 (p1-7d-gui launch/enter/provider, claude-sdk plan).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [lang = 'ts', lines = '400', per = '5', pieceMs = '100'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const gui = path.resolve(here, '../../../../plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs');
const unit = [
  'export async function load(id: string, opts?: { force?: boolean }): Promise<Item | null> {',
  '  const key = `item:${id}`; // cache key',
  '  if (!opts?.force && cache.has(key)) return cache.get(key) ?? null;',
  "  const res = await fetch(`/api/items/${encodeURIComponent(id)}`, { method: 'GET' });",
  '  if (!res.ok) throw new Error(`load failed: ${res.status}`);',
  '  const item = (await res.json()) as Item;',
  '  cache.set(key, item);',
  '  return item;',
  '}',
  '',
];
const body = Array.from({ length: Number(lines) }, (_, i) => `${unit[i % unit.length]}\n`);
const pieces = [`前言\n\n\`\`\`${lang === 'none' ? '' : lang}\n`];
for (let i = 0; i < body.length; i += Number(per)) pieces.push(body.slice(i, i + Number(per)).join(''));
pieces.push('```\n', '\n后记');
const message = `CC-TEXT ${JSON.stringify({ pieces, chunkMs: Number(pieceMs) })}`;

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await evalJs(`[...document.querySelectorAll('button,a')].find(b=>b.innerText.trim()==='新建对话')?.click()`);
await sleep(1500);
await evalJs(`(()=>{
  const p = window.__hlProbe = { long: [], lagMax: 0, lagOver50: 0 };
  new PerformanceObserver((l)=>{ for (const e of l.getEntries()) p.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask' });
  let last = performance.now();
  p.timer = setInterval(()=>{ const now = performance.now(); const lag = now - last - 10; if (lag > p.lagMax) p.lagMax = lag; if (lag > 50) p.lagOver50++; last = now; }, 10);
  return true; })()`);
const profiling = process.env.HL_PROFILE === '1';
if (profiling) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
execFileSync('node', [gui, 'send', message], { stdio: 'ignore', env: process.env });
const t0 = await evalJs('performance.now()');
let tCode = null, tDone = null;
for (let i = 0; i < 600; i++) {
  await sleep(200);
  // textContent, not innerText: innerText forces a layout of the whole page,
  // which would itself show up as main-thread time.
  const s = await evalJs(`(()=>{const t=document.body.textContent;const i=t.lastIndexOf('后记');return {code:t.includes('export async function load'), done:i>=0 && t.indexOf('完成于', i)>=0 && !t.slice(i-2,i).includes('n'), now:performance.now()}})()`);
  if (s.code && tCode === null) tCode = s.now;
  if (s.done) { tDone = s.now; break; }
}
await sleep(3000);
let byPart = null;
if (profiling) {
  // Self time per part, from the sampled profile: shiki (tokenizer + regex engine),
  // react-dom (rendering the spans), the app's own chat code, the rest.
  const { profile } = (await send('Profiler.stop')).result;
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  byPart = {};
  var others = {};
  for (const n of profile.nodes) {
    const url = n.callFrame.url;
    const fn = n.callFrame.functionName;
    const part = /shiki|oniguruma|regex/.test(url) ? 'shiki' : /react-dom|scheduler/.test(url) ? 'react' : /components\/chat/.test(url) ? 'chat' : fn === '(idle)' || fn === '(program)' ? fn : fn === '(garbage collector)' ? 'gc' : 'other';
    byPart[part] = (byPart[part] ?? 0) + (dt.get(n.id) ?? 0);
    if (part === 'other') { const k = `${url.replace(/^.*\//, '').replace(/\?.*$/, '') || '(native)'} ${fn || '(anon)'}`; others[k] = (others[k] ?? 0) + (dt.get(n.id) ?? 0); }
  }
  for (const k of Object.keys(byPart)) byPart[k] = Math.round(byPart[k]);
  byPart.topOther = Object.entries(others).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v)}`);
}
const r = await evalJs(`(()=>{const p=window.__hlProbe;clearInterval(p.timer);return {long:p.long,lagMax:p.lagMax,lagOver50:p.lagOver50,spans:[...document.querySelectorAll('pre')].at(-1)?.querySelectorAll('span').length}})()`);
const during = r.long.filter(([s]) => s >= t0 && s <= tDone);
const after = r.long.filter(([s]) => s > tDone);
const sum = (xs) => Math.round(xs.reduce((a, [, d]) => a + d, 0));
const max = (xs) => Math.round(Math.max(0, ...xs.map(([, d]) => d)));
console.log(JSON.stringify({
  lang, lines: Number(lines), pieces: pieces.length, pieceMs: Number(pieceMs),
  streamSeconds: tDone && tCode ? +((tDone - tCode) / 1000).toFixed(1) : null,
  longTasksDuring: { count: during.length, totalMs: sum(during), maxMs: max(during) },
  longTasksAfterDone3s: { count: after.length, totalMs: sum(after), maxMs: max(after) },
  byPartMs: byPart,
  // When the long tasks fell, in ms before the turn was seen done (negative = before).
  longTaskTimesMs: during.map(([start, d]) => `${Math.round(start - tDone)}:${Math.round(d)}`),
  maxEventLoopLagMs: Math.round(r.lagMax), lagsOver50ms: r.lagOver50, finalSpans: r.spans,
}, null, 1));
ws.close();
process.exit(0);
