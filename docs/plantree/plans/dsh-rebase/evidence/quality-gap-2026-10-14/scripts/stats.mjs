// Aggregate, content-free statistics over local DSH session logs.
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readLog } from './readlog.mjs';

const root = process.argv[2];
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.jsonl.zstd')) files.push(p);
  }
};
walk(root);
const all = { calls: {}, errors: {}, unknown: {}, exitNonZero: 0, shellCalls: 0 };
for (const f of files) {
  const ev = readLog(f);
  const s = {
    session: basename(dirname(f)),
    turns: 0,
    steps: 0,
    models: {},
    efforts: {},
    maxTokens: new Set(),
    toolsOffered: 0,
    sysLen: new Set(),
    calls: {},
    errors: {},
    unknown: {},
    usage: { in: 0, out: 0, cacheR: 0, cacheW: 0, maxIn: 0 },
    retries: 0,
    reasoningBlocks: 0,
    assistant: 0,
    userKinds: {},
  };
  for (const e of ev) {
    const d = e.data ?? {};
    if (e.type === 'turn/start') s.turns++;
    if (e.type === 'step/start') s.steps++;
    if (e.type === 'llm/retry') s.retries++;
    if (e.type === 'system/message') s.sysLen.add(d.message?.content?.[0]?.text?.length);
    if (e.type === 'user/message') {
      const k = d.source?.kind ?? '?';
      s.userKinds[k] = (s.userKinds[k] ?? 0) + 1;
    }
    if (e.type === 'request/header') {
      const c = d.header?.config ?? {};
      const m = `${c.provider}/${c.model}`;
      s.models[m] = (s.models[m] ?? 0) + 1;
      s.efforts[c.reasoningEffort ?? '(none)'] =
        (s.efforts[c.reasoningEffort ?? '(none)'] ?? 0) + 1;
      s.maxTokens.add(c.maxTokens);
      s.toolsOffered = d.header?.tools?.length ?? s.toolsOffered;
      s.toolNames = (d.header?.tools ?? []).map((t) => t.name);
    }
    if (e.type === 'assistant/message') {
      s.assistant++;
      const u = d.usage ?? {};
      s.usage.in += u.inputTokens ?? 0;
      s.usage.out += u.outputTokens ?? 0;
      s.usage.cacheR += u.cacheReadTokens ?? 0;
      s.usage.cacheW += u.cacheWriteTokens ?? 0;
      const ctx = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      if (ctx > s.usage.maxIn) s.usage.maxIn = ctx;
      for (const b of d.message?.content ?? []) if (b.type === 'reasoning') s.reasoningBlocks++;
    }
    if (e.type === 'tool/call') {
      s.calls[d.name] = (s.calls[d.name] ?? 0) + 1;
      all.calls[d.name] = (all.calls[d.name] ?? 0) + 1;
      if (s.toolNames && !s.toolNames.includes(d.name)) {
        s.unknown[d.name] = (s.unknown[d.name] ?? 0) + 1;
        all.unknown[d.name] = (all.unknown[d.name] ?? 0) + 1;
      }
    }
    if (e.type === 'tool/result') {
      const text = (d.message?.content ?? []).map((c) => c.text ?? '').join('');
      if (d.message?.isError) {
        const k = /unknown tool/i.test(text) ? 'unknown-tool' : 'error';
        s.errors[k] = (s.errors[k] ?? 0) + 1;
        all.errors[k] = (all.errors[k] ?? 0) + 1;
      }
      const m = text.match(/\[exit code: (\d+)\]/);
      if (m && m[1] !== '0') all.exitNonZero++;
    }
  }
  for (const e of ev)
    if (e.type === 'tool/call' && (e.data.name === 'pwsh' || e.data.name === 'bash'))
      all.shellCalls++;
  delete s.toolNames;
  console.log(JSON.stringify({ ...s, maxTokens: [...s.maxTokens], sysLen: [...s.sysLen] }));
}
console.log('ALL', JSON.stringify(all));
