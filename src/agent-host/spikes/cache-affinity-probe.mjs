// Gateway prompt-cache affinity probe (BUG-2026-07-29-prompt-cache-rewrite).
//
// Sends a fixed ~8.6k-token cached system prompt, then:
//   T1 fresh -> T1 byte-identical repeat -> T2 grown prefix -> T2 repeat -> T3 grown.
// Through a healthy gateway (or api.anthropic.com directly) every repeat AND
// every grown-prefix turn after the first must show cache_read > 0. A gateway
// that load-balances across upstream accounts without session affinity shows
// nondeterministic reads (identical repeats usually hit, grown turns coin-flip).
//
// Usage:
//   ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=... node spikes/cache-affinity-probe.mjs [model]
// Cost: ~5 requests x ~8.6k 1h-TTL cache writes worst case.
const model = process.argv[2] || 'claude-sonnet-4-6';
const base = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '');
const token = process.env.ANTHROPIC_AUTH_TOKEN;
if (!base || !token) {
  console.error('ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are required');
  process.exit(1);
}

// Per-run marker: never read a previous run's cache, but stay byte-stable within the run.
const runId = `cacheprobe-${Date.now()}`;
const filler = Array.from(
  { length: 260 },
  (_, i) =>
    `Section ${i}: The quick brown fox jumps over the lazy dog while counting tokens for cache probe purposes. This sentence exists purely as deterministic ballast.`
).join('\n');
const system = [
  {
    type: 'text',
    text: `You are a terse assistant. Run marker: ${runId}\n${filler}`,
    cache_control: { type: 'ephemeral', ttl: '1h' },
  },
];

async function call(label, messages) {
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 32, system, messages }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return null;
  }
  const u = json.usage || {};
  console.log(
    `${label}: ${Date.now() - t0}ms input=${u.input_tokens} ` +
      `write=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens}`
  );
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const msgs = [{ role: 'user', content: 'Reply with exactly: OK-1' }];
const a = await call('T1        (expect write)', msgs);
if (!a) process.exit(1);
await sleep(1500);
await call('T1 repeat (expect read) ', msgs);
await sleep(1500);
msgs.push({
  role: 'assistant',
  content: a.content?.find((c) => c.type === 'text')?.text || 'OK-1',
});
msgs.push({ role: 'user', content: 'Reply with exactly: OK-2' });
const b = await call('T2 grown  (read? = affinity)', msgs);
await sleep(1500);
await call('T2 repeat (expect read) ', msgs);
await sleep(1500);
msgs.push({
  role: 'assistant',
  content: b?.content?.find((c) => c.type === 'text')?.text || 'OK-2',
});
msgs.push({ role: 'user', content: 'Reply with exactly: OK-3' });
await call('T3 grown  (read? = affinity)', msgs);
