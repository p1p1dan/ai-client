import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, slugify } from '../src/index.js';

test('acceptance: maxLength cuts the slug without a trailing separator', () => {
  assert.equal(slugify('Hello World Again', { maxLength: 11 }), 'hello-world');
  assert.equal(slugify('Hello World Again', { maxLength: 12 }), 'hello-world');
  assert.equal(slugify('Hello World Again', { maxLength: 5 }), 'hello');
  assert.equal(slugify('Hello World', { maxLength: 100 }), 'hello-world');
  assert.equal(slugify('a b c d', { separator: '_', maxLength: 4 }), 'a_b');
});

test('acceptance: without maxLength nothing changes', () => {
  assert.equal(slugify('Hello World Again'), 'hello-world-again');
});

test('acceptance: the default lives in DEFAULTS', () => {
  assert.ok(Object.hasOwn(DEFAULTS, 'maxLength'));
});

test('acceptance: an invalid maxLength is a TypeError', () => {
  for (const maxLength of [0, -1, 2.5, '3', Number.NaN]) {
    assert.throws(() => slugify('Hello', { maxLength }), TypeError, String(maxLength));
  }
});
