/** Serialized atomic writer for small managed files such as the one-time adoption marker. */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const writeQueues = new Map<string, Promise<void>>();
let tmpCounter = 0;

function randomTmpSuffix(): string {
  tmpCounter = (tmpCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now()}-${tmpCounter}`;
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomTmpSuffix()}.tmp`;
  writeFileSync(tmpPath, content, { encoding: 'utf-8' });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function enqueueWrite(path: string, run: () => void): Promise<void> {
  const key = resolve(path);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const task = previous.then(run, run);
  writeQueues.set(
    key,
    task.then(
      () => undefined,
      () => undefined
    )
  );
  return task;
}

/** Atomically replace a managed file while serializing writes to the same path. */
export function writeManagedFile(path: string, content: string): Promise<void> {
  return enqueueWrite(path, () => writeTextAtomic(resolve(path), content));
}

/** Test-only: drop queued state between test cases. */
export function resetManagedFileWriterQueuesForTests(): void {
  writeQueues.clear();
}
