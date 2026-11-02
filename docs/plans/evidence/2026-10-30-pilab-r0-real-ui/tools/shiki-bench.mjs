// PiLab R2 (07.7): how long chatShiki's codeToTokens takes, per call and summed
// over a stream, with the same core + JS regex engine + vitesse themes.
// Run from the repo root: node docs/plans/evidence/2026-10-30-pilab-r0-real-ui/tools/shiki-bench.mjs
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import ts from 'shiki/langs/typescript.mjs';
import dark from 'shiki/themes/vitesse-dark.mjs';
import light from 'shiki/themes/vitesse-light.mjs';

const hl = await createHighlighterCore({ themes: [dark, light], langs: [ts], engine: createJavaScriptRegexEngine() });
const unit = [
  'export async function load(id: string, opts?: { force?: boolean }): Promise<Item | null> {',
  "  const key = `item:${id}`; // cache key",
  '  if (!opts?.force && cache.has(key)) return cache.get(key) ?? null;',
  '  const res = await fetch(`/api/items/${encodeURIComponent(id)}`, { method: "GET" });',
  '  if (!res.ok) throw new Error(`load failed: ${res.status}`);',
  '  const item = (await res.json()) as Item;',
  '  cache.set(key, item);',
  '  return item;',
  '}',
  '',
];
const code = (lines) => Array.from({ length: lines }, (_, i) => unit[i % unit.length]).join('\n');
const time = (fn, reps = 5) => {
  fn(); // warm
  const t = [];
  for (let i = 0; i < reps; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
};
const out = { node: process.version, perCall: {}, stream: {} };
for (const n of [50, 200, 400, 800]) {
  const c = code(n);
  out.perCall[n] = +time(() => hl.codeToTokens(c, { lang: 'typescript', theme: 'vitesse-dark' })).toFixed(1);
}
// A stream: the block grows by `step` lines per flush and is re-tokenized whole each time.
for (const [n, step] of [[200, 2], [400, 4], [800, 8]]) {
  let total = 0, max = 0, calls = 0;
  for (let k = step; k <= n; k += step) {
    const c = code(k);
    const s = performance.now();
    hl.codeToTokens(c, { lang: 'typescript', theme: 'vitesse-dark' });
    const d = performance.now() - s;
    total += d; max = Math.max(max, d); calls++;
  }
  out.stream[`${n} lines, +${step}/flush`] = { calls, totalMs: Math.round(total), maxMs: +max.toFixed(1) };
}
// The same streams, tokenised the way chatShiki does since R2: from the first
// changed line on, each line from the previous line's grammar state.
out.incremental = {};
for (const [n, step] of [[200, 2], [400, 4], [800, 8]]) {
  let prevSource = [], prevStates = [], total = 0, max = 0;
  for (let k = step; k <= n; k += step) {
    const source = code(k).split('\n');
    const s = performance.now();
    let start = 0;
    while (start < Math.min(prevSource.length, source.length) && prevSource[start] === source[start]) start++;
    const states = prevStates.slice(0, start);
    for (let i = start; i < source.length; i++) {
      const rows = hl.codeToTokensBase(source[i], { lang: 'typescript', theme: 'vitesse-dark', grammarState: i > 0 ? states[i - 1] : undefined });
      states.push(hl.getLastGrammarState(rows));
    }
    const d = performance.now() - s;
    total += d; max = Math.max(max, d);
    prevSource = source; prevStates = states;
  }
  out.incremental[`${n} lines, +${step}/flush`] = { totalMs: Math.round(total), maxMs: +max.toFixed(1) };
}
console.log(JSON.stringify(out, null, 1));
