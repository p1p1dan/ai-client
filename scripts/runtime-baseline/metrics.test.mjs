import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertToolCall, summarizeUsage } from './metrics.mjs';

const row = (ordinal, input, cacheRead, extra = {}) => ({
  caseId: 'B01',
  source: 'turn',
  ordinal,
  usage: { input, cacheRead, output: 1, cacheWrite: 1000, totalTokens: 2000 },
  ...extra,
});

test('uses weighted token totals, excludes writes and compaction', () => {
  const rows = [row(1, 10, 90), row(2, 900, 0), row(3, 500, 500, { source: 'compaction' })];
  assert.equal(summarizeUsage(rows).cacheHitRate, 0.09);
  assert.equal(summarizeUsage(rows, 'compaction').cacheHitRate, 0.5);
});

test('rejects missing, invalid and empty prompt usage instead of inventing zero', () => {
  for (const value of [undefined, NaN, -1, Infinity]) {
    assert.throws(() => summarizeUsage([row(1, 10, value)]), /Unmeasurable/);
  }
  assert.throws(() => summarizeUsage([row(1, 0, 0)]), /No prompt usage/);
  assert.equal(summarizeUsage([]).cacheHitRate, null);
  assert.equal(summarizeUsage([row(1, 5, 0)]).cacheHitRate, 0);
});

test('rejects duplicate turns including replayed resume history', () => {
  assert.throws(() => summarizeUsage([row(1, 1, 2), row(1, 1, 2)]), /Duplicate/);
  assert.equal(summarizeUsage([row(1, 1, 2), row(1, 1, 2, { caseId: 'B02' })]).calls, 2);
});

test('restricts tools to the exact fixture action', () => {
  const expected = { name: 'read', args: { path: 'facts.txt', offset: 20 } };
  assertToolCall(
    { toolName: 'read', input: { path: '/work/facts.txt', offset: 20 } },
    expected,
    '/work'
  );
  assert.throws(() =>
    assertToolCall({ toolName: 'read', input: { path: '/etc/passwd' } }, expected, '/work')
  );
  assert.throws(() => assertToolCall({ toolName: 'bash', input: {} }, expected, '/work'));
  assert.throws(() => assertToolCall({ toolName: 'read', input: {} }, undefined, '/work'));
});

test('checks the SDK edit array without rejecting equivalent objects', () => {
  const args = { path: 'config.txt', edits: [{ oldText: 'port=4317', newText: 'port=4318' }] };
  const expected = { name: 'edit', args };
  assertToolCall({ toolName: 'edit', input: structuredClone(args) }, expected, '/work');
  assert.throws(() =>
    assertToolCall(
      { toolName: 'edit', input: { ...args, edits: [{ oldText: 'wrong', newText: 'bad' }] } },
      expected,
      '/work'
    )
  );
});
