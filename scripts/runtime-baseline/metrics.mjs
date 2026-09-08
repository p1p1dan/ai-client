import assert from 'node:assert/strict';

export function summarizeUsage(records, source = 'turn') {
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const seen = new Set();
  for (const record of records.filter((item) => item.source === source)) {
    const identity = `${record.caseId}:${record.source}:${record.ordinal}`;
    assert(!seen.has(identity), `Duplicate usage: ${identity}`);
    seen.add(identity);
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      const value = record.usage[field];
      assert(Number.isFinite(value) && value >= 0, `Unmeasurable ${identity}.${field}`);
      totals[field] += value;
    }
    assert(record.usage.input + record.usage.cacheRead > 0, `No prompt usage: ${identity}`);
    totals.calls++;
  }
  const denominator = totals.input + totals.cacheRead;
  return { ...totals, cacheHitRate: denominator > 0 ? totals.cacheRead / denominator : null };
}

export function assertToolCall(actual, expected, cwd) {
  assert(expected, `Unexpected tool: ${actual.toolName}`);
  assert.equal(actual.toolName, expected.name);
  for (const [key, value] of Object.entries(expected.args)) {
    const received = key === 'path' ? actual.input[key]?.replace(`${cwd}/`, '') : actual.input[key];
    assert.deepEqual(received, value, `Unexpected ${expected.name}.${key}`);
  }
}
