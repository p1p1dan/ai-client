// Residual = billed prompt tokens - what PiLab sent (estimate) - replayed thinking (estimate), per step.
import { readLog } from './readlog.mjs';

const est = (s) => {
  let cjk = 0;
  for (const ch of s) if (/[　-鿿＀-￯]/.test(ch)) cjk++;
  return Math.round((s.length - cjk) / 3.6 + cjk * 1.1);
};
const texts = (content) =>
  (Array.isArray(content) ? content : [content])
    .map((c) =>
      typeof c === 'string' ? c : (c?.text ?? (c?.type === 'tool-call' ? c.name + c.arguments : ''))
    )
    .join('');
const ev = readLog(process.argv[2]);
let base = 0,
  msgs = 0,
  thinking = 0,
  step = 0,
  turn = 0;
const out = [];
for (const e of ev) {
  const d = e.data ?? {};
  if (e.type === 'turn/start') turn++;
  if (e.type === 'request/header') base = est(JSON.stringify(d.header?.tools ?? []));
  if (e.type === 'system/message') base += est(texts(d.message?.content));
  if (e.type === 'user/message') msgs += est(texts(d.content));
  if (e.type === 'tool/result') msgs += est(texts(d.message?.content));
  if (e.type === 'compaction/end' || e.type === 'compaction/applied') {
    out.push(`  -- ${e.type}`);
  }
  if (e.type === 'assistant/message') {
    step++;
    const u = d.usage ?? {};
    const billed = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    const visible = est(texts((d.message?.content ?? []).filter((b) => b.type !== 'reasoning')));
    const residual = billed - (base + msgs) - thinking;
    out.push(
      `t${turn} s${step} billed=${billed} sent~${base + msgs} thinking~${thinking} residual=${residual} cacheR=${u.cacheReadTokens ?? 0} cacheW=${u.cacheWriteTokens ?? 0} in=${u.inputTokens ?? 0}`
    );
    msgs += visible;
    thinking += Math.max(0, (u.outputTokens ?? 0) - visible);
  }
}
console.log(out.join('\n'));
