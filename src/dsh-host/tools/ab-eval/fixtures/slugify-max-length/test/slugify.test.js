import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/index.js';

test('slugify lowercases and joins words with the separator', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify trims separators at both ends', () => {
  assert.equal(slugify('  --Hello, World!--  '), 'hello-world');
});

test('slugify honours a custom separator', () => {
  assert.equal(slugify('Hello World', { separator: '_' }), 'hello_world');
});

test('slugify can keep the case', () => {
  assert.equal(slugify('Hello World', { lowercase: false }), 'Hello-World');
});

test('slugify strips accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});
