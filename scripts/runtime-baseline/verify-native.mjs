/**
 * Offline re-verification of a native-runtime collection (P2-5).
 *
 * Same job as `verify.mjs` does for the legacy archive: recompute every number
 * from the raw records and re-check every step assertion without touching the
 * gateway. A separate file because the two backends persist different session
 * formats — pi's v4 JSONL here (header line + `kind:"entry"` rows) against the
 * SDK's own log there — and a verifier that silently accepted either shape
 * would stop being able to say WHICH one it proved.
 *
 *   node scripts/runtime-baseline/verify-native.mjs <run-dir>
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertToolCall, summarizeUsage } from './metrics.mjs';

const root = resolve(process.argv[2] ?? '.');
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const readLines = (name) =>
  readFileSync(join(root, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const manifest = readJson('manifest.json');
const suite = readJson('suite.json');
const summary = readJson('summary.json');
assert.equal(manifest.backend, 'native', 'Not a native-backend archive');
assert(summary.validBaseline, 'Archive is a preflight, failed run, or incomplete suite');
assert.equal(
  manifest.suiteSha256,
  createHash('sha256')
    .update(readFileSync(join(root, 'suite.json')))
    .digest('hex')
);
assert.deepEqual(
  manifest.caseOrder,
  suite.cases.map((item) => item.id)
);
assert.deepEqual(
  summary.results.map((item) => item.caseId),
  manifest.caseOrder
);
// The six native tools must all be present: a run that silently lost one would
// still pass its prompts while comparing a different prefix than it claims to.
const NATIVE_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep'];

const allUsage = [];
for (const testCase of suite.cases) {
  const result = readJson(`${testCase.id}/result.json`);
  const rows = readLines(`${testCase.id}/usage.jsonl`);
  const events = readLines(`${testCase.id}/trace.jsonl`);
  assert(result.passed, `Failed ${testCase.id}`);
  assert.equal(result.assertions.length, testCase.steps.length);
  assert(result.assertions.every((item) => item.passed));
  assert.equal(events.filter((item) => item.type === 'step_passed').length, testCase.steps.length);
  assert.deepEqual(result.usage, summarizeUsage(rows));
  assert.deepEqual(result.compactionUsage, summarizeUsage(rows, 'compaction'));
  assert.deepEqual(
    summary.results.find((item) => item.caseId === testCase.id),
    result
  );

  const sessionFiles = readdirSync(join(root, testCase.id, 'sessions')).filter((name) =>
    name.endsWith('.jsonl')
  );
  assert.equal(sessionFiles.length, 1, `Expected one durable session in ${testCase.id}`);
  const lines = readLines(`${testCase.id}/sessions/${sessionFiles[0]}`);
  const header = lines[0];
  assert.equal(header.kind, 'header', `Missing v4 header in ${testCase.id}`);
  assert.equal(header.version, 4, `Unexpected session version in ${testCase.id}`);
  const entries = lines.slice(1).filter((line) => line.kind === 'entry');
  const assistantUsage = entries
    .filter((item) => item.type === 'message' && item.message.role === 'assistant')
    .map((item) => item.message.usage);
  assert.deepEqual(
    rows.filter((item) => item.source === 'turn').map((item) => item.usage),
    assistantUsage,
    `Usage drift or duplicate resume in ${testCase.id}`
  );
  const compaction = entries.filter((item) => item.type === 'compaction');
  assert.equal(
    compaction.length,
    testCase.steps.filter((step) => step.action === 'compact').length
  );
  assert.deepEqual(
    rows.filter((item) => item.source === 'compaction').map((item) => item.usage),
    compaction.map((item) => item.usage).filter(Boolean)
  );
  for (const entry of compaction) {
    assert(entry.summary.trim(), `Empty compaction summary in ${testCase.id}`);
    assert(Array.isArray(entry.retainedTail), `Missing retained tail in ${testCase.id}`);
  }
  assert.equal(
    events.filter((item) => item.type === 'resume_verified').length,
    testCase.steps.filter((step) => step.action === 'resume').length
  );
  for (const [file, initial] of Object.entries(testCase.files)) {
    assert.equal(readFileSync(join(root, testCase.id, 'initial-workspace', file), 'utf8'), initial);
    assert.equal(
      readFileSync(join(root, testCase.id, 'final-workspace', file), 'utf8'),
      testCase.finalFiles?.[file] ?? initial
    );
  }

  const requests = events.filter((item) => item.type === 'provider_request');
  assert(requests.length >= assistantUsage.length, `Missing request payloads in ${testCase.id}`);
  for (const request of requests) {
    assert.equal(request.payload.model, suite.model.id);
    assert(request.payload.systemPromptBytes > 0, `Empty system prompt in ${testCase.id}`);
  }
  const bootstraps = events.filter((item) => item.type === 'bootstrap');
  assert(bootstraps.length >= 1, `Missing bootstrap record in ${testCase.id}`);
  for (const item of bootstraps) {
    assert(item.systemPrompt.length > 0, `Empty composed prompt in ${testCase.id}`);
    const names = item.tools.map((tool) => tool.name);
    for (const tool of NATIVE_TOOLS)
      assert(names.includes(tool), `Native tool ${tool} absent in ${testCase.id}`);
  }

  for (const [stepIndex, step] of testCase.steps.entries()) {
    if (step.action !== 'prompt') continue;
    const stepEvents = events
      .filter((item) => item.stepIndex === stepIndex && item.type === 'sdk_event')
      .map((item) => item.event);
    const calls = stepEvents.filter((item) => item.type === 'tool_execution_start');
    assert.equal(
      calls.length,
      step.tools.length,
      `Tool count drift in ${testCase.id}/${stepIndex}`
    );
    for (const [index, call] of calls.entries()) {
      assertToolCall(
        { toolName: call.toolName, input: call.args },
        step.tools[index],
        join(manifest.work, testCase.id)
      );
    }
    assert(
      stepEvents.filter((item) => item.type === 'tool_execution_end').every((item) => !item.isError)
    );
    const last = stepEvents.filter((item) => item.type === 'turn_end').at(-1)?.message;
    assert(last, `Missing final assistant in ${testCase.id}/${stepIndex}`);
    assert.equal(last.stopReason, 'stop');
    const text = last.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    for (const marker of step.contains) assert(text.includes(marker), `Missing marker ${marker}`);
  }

  if (testCase.id === 'B04') {
    const reads = events.filter(
      (item) =>
        item.type === 'sdk_event' &&
        item.event.type === 'tool_execution_end' &&
        item.event.toolName === 'read'
    );
    assert.equal(reads.length, 2, 'Expected exactly two reads in B04');
    assert.equal(reads[0].event.result.details.truncated, true, 'First B04 read was not truncated');
    assert(
      reads[0].event.result.details.nextOffset > 1,
      'Truncated read did not report a continuation offset'
    );
    assert(
      reads[1].event.result.content.some((part) => part.text?.includes('TAIL_MARKER=AMBER')),
      'Paged read missed the tail marker'
    );
  }
  allUsage.push(...rows);
}
assert.deepEqual(summary.usage, summarizeUsage(allUsage));
assert.deepEqual(summary.compactionUsage, summarizeUsage(allUsage, 'compaction'));
console.log(
  JSON.stringify(
    {
      verified: true,
      backend: manifest.backend,
      cases: suite.cases.length,
      usage: summary.usage,
      compactionUsage: summary.compactionUsage,
    },
    null,
    2
  )
);
