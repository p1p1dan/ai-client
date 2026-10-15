import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mean, median, range } from '../src/stats.js';

test('mean averages the values', () => {
  assert.equal(mean([2, 4, 9]), 5);
});

test('median of an odd-length list is the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median handles multi-digit numbers', () => {
  assert.equal(median([10, 9, 2]), 9);
});

test('median of an even-length list averages the two middle values', () => {
  assert.equal(median([1, 10, 2, 9]), 5.5);
});

test('range is max minus min', () => {
  assert.equal(range([4, 12, 7]), 8);
});

test('empty input is rejected', () => {
  assert.throws(() => mean([]), RangeError);
  assert.throws(() => median([]), RangeError);
  assert.throws(() => range([]), RangeError);
});
