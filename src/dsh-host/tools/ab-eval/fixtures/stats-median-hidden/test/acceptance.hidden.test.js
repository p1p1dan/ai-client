import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median } from '../src/stats.js';

test('acceptance: median sorts numerically, negatives and decimals included', () => {
  assert.equal(median([-5, 3, -1]), -1);
  assert.equal(median([0.5, 0.25, 1]), 0.5);
  assert.equal(median([100, 20, 3, 4]), 12);
});

test('acceptance: median leaves its input untouched', () => {
  const input = [10, 9, 2];
  median(input);
  assert.deepEqual(input, [10, 9, 2]);
});
