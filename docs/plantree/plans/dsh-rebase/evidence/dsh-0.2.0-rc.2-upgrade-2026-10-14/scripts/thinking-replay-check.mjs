// Decision 189 evidence harness: how P1-CHAIN thinking blocks come back
// in later anthropic-messages requests captured by fake-gateway.mjs --capture.
//   node thinking-replay-check.mjs <capture-dir> [--json out.json]
//
// The gateway answers P1-CHAIN step i with: i%3==0 thinking text signed
// `sig-<seq>-<i>`, i%3==1 empty thinking with that signature, i%3==2
// redacted_thinking. For every replayed step of every request this reports how
// the step's thinking came back: `thinking` (a thinking block with a non-empty
// signature), `redacted` (a redacted_thinking block), `as-text` (its text moved
// into a plain text block) or `dropped` (nothing).
import fs from 'node:fs';
import path from 'node:path';

const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node thinking-replay-check.mjs <capture-dir> [--json out.json]');
  process.exit(2);
}
const jsonOut = rest[0] === '--json' ? rest[1] : undefined;

const EXPECTED = ['summarized', 'empty', 'redacted'];
const files = fs
  .readdirSync(dir)
  .filter((name) => /^\d+\.json$/.test(name))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

const tally = {};
const perRequest = [];
for (const name of files) {
  const capture = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  let body;
  try {
    body = JSON.parse(capture.body);
  } catch {
    continue;
  }
  if (!Array.isArray(body.messages)) continue;
  let step = -1;
  let inChain = false;
  const steps = [];
  for (const message of body.messages) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
    if (message.role === 'user') {
      const isToolResult = blocks.some((block) => block.type === 'tool_result');
      if (!isToolResult) {
        const text = blocks.map((block) => block.text ?? '').join('');
        // A P1-CHAIN prompt starts a chain; injected context (runtime context,
        // skill reminders) and interjected notes do not end it.
        if (text.includes('P1-CHAIN')) {
          inChain = true;
          step = -1;
        }
      }
      continue;
    }
    if (message.role !== 'assistant' || !inChain) continue;
    if (!blocks.some((block) => block.type === 'tool_use')) continue;
    step += 1;
    const thinking = blocks.find((block) => block.type === 'thinking');
    const redacted = blocks.find((block) => block.type === 'redacted_thinking');
    const asText = blocks.find(
      (block) =>
        block.type === 'text' &&
        /P1-CHAIN .* step \d+: the last result is in/.test(block.text ?? '')
    );
    let form = 'dropped';
    if (redacted) form = 'redacted';
    else if (thinking && typeof thinking.signature === 'string' && thinking.signature.length > 0)
      form = 'thinking';
    else if (thinking) form = 'thinking-unsigned';
    else if (asText) form = 'as-text';
    const expected = EXPECTED[step % 3];
    steps.push({ step, expected, form });
    tally[expected] ??= {};
    tally[expected][form] = (tally[expected][form] ?? 0) + 1;
  }
  if (steps.length > 0) perRequest.push({ seq: capture.seq, model: body.model, steps });
}

const summary = { captureDir: dir, requestsWithReplayedSteps: perRequest.length, tally };
console.log(JSON.stringify(summary, null, 2));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ...summary, perRequest }, null, 2));
