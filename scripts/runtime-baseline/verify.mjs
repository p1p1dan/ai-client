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
const allUsage = [];
for (const testCase of suite.cases) {
  if (manifest.sourceRuns) {
    const source = manifest.sourceRuns.find((item) => item.caseId === testCase.id);
    assert(source, `Missing source ${testCase.id}`);
    const sourceSuite = readJson(`sources/${source.run}/suite.json`);
    const sourceManifest = readJson(`sources/${source.run}/manifest.json`);
    assert.equal(
      sourceManifest.suiteSha256,
      createHash('sha256')
        .update(readFileSync(join(root, 'sources', source.run, 'suite.json')))
        .digest('hex')
    );
    assert.deepEqual(
      sourceSuite.cases.find((item) => item.id === testCase.id),
      testCase
    );
    assert.equal(
      source.caseSha256,
      createHash('sha256').update(JSON.stringify(testCase)).digest('hex')
    );
    for (const field of [
      'backend',
      'entry',
      'dependencies',
      'baseUrl',
      'provider',
      'model',
      'settings',
      'work',
    ]) {
      assert.deepEqual(sourceManifest[field], manifest[field]);
    }
    for (const [file, digest] of Object.entries(manifest.files)) {
      if (file !== 'scripts/runtime-baseline/suite.mjs')
        assert.equal(sourceManifest.files[file], digest);
    }
  }
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
  const entries = readLines(`${testCase.id}/sessions/${sessionFiles[0]}`);
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
    compaction.map((item) => item.usage)
  );
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
  }
  const bootstraps = events.filter((item) => item.type === 'bootstrap');
  assert(bootstraps.every((item) => item.extensions.length >= 2 && item.systemPrompt.length > 0));
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
    assert.equal(reads[0].event.result.details.truncation.truncated, true);
    assert.equal(reads[0].event.result.details.truncation.truncatedBy, 'bytes');
    assert(reads[1].event.result.content.some((part) => part.text?.includes('TAIL_MARKER=AMBER')));
  }
  allUsage.push(...rows);
}
assert.deepEqual(summary.usage, summarizeUsage(allUsage));
assert.deepEqual(summary.compactionUsage, summarizeUsage(allUsage, 'compaction'));
console.log(
  JSON.stringify(
    {
      verified: true,
      cases: suite.cases.length,
      usage: summary.usage,
      compactionUsage: summary.compactionUsage,
    },
    null,
    2
  )
);
