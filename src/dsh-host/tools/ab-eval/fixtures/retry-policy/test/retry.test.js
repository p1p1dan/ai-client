import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, isRetryable } from '../src/errors.js';
import { delayFor, withRetry } from '../src/retry.js';

const noSleep = async () => {};

test('a task that succeeds runs once', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      return 'ok';
    },
    undefined,
    noSleep
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('a client error is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new HttpError(404);
      },
      undefined,
      noSleep
    ),
    HttpError
  );
  assert.equal(calls, 1);
});

test('the first delay is the base delay', () => {
  assert.equal(delayFor(1), 200);
});

test('429 and 5xx are retryable', () => {
  assert.ok(isRetryable(new HttpError(429)));
  assert.ok(isRetryable(new HttpError(502)));
  assert.ok(!isRetryable(new HttpError(400)));
  assert.ok(!isRetryable(new Error('boom')));
});
