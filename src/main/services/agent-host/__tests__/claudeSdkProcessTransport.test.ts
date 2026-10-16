import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClaudeSdkProcessTransport } from '../ClaudeSdkProcessTransport';

/**
 * Route B S-3 (topic s3-project-config.md K-5): Main hands the SDK host the
 * gateway key as the first IPC message, never in its environment. A real child
 * (this test's own node) reports what it got first and whether the key is
 * anywhere in its environment.
 */

const KEY = 'sk-fake-transport-test-key';
const CHILD = `
process.once('message', (first) => {
  const envHasKey = Object.values(process.env).some((value) => value === first.apiKey);
  process.send({ first, envHasKey }, () => process.exit(0));
});
`;

describe('ClaudeSdkProcessTransport', () => {
  it('sends the key as the first message and never in the environment', async () => {
    const transport = new ClaudeSdkProcessTransport({
      command: process.execPath,
      args: ['-e', CHILD],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      apiKey: KEY,
    });
    const report = await new Promise<unknown>((resolve) => transport.onMessage(resolve));
    expect(report).toEqual({ first: { type: 'host.secret', apiKey: KEY }, envHasKey: false });
    await new Promise<void>((resolve) => transport.onExit(() => resolve()));
  });
});
