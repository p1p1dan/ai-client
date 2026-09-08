import { runHostToolsProbe } from './p1-host-tools.ts';

const [cwd, nodePath, shellPath] = process.argv.slice(2);
const port = (process as typeof process & { parentPort: { postMessage(value: unknown): void } })
  .parentPort;
try {
  const result = await runHostToolsProbe(
    {
      carrier: 'electron-utility',
      node: { path: nodePath, source: 'explicit' },
      tsdReadFallback: 'disabled',
      exec: { mode: 'pipe' },
      childEnv: { PATH: process.env.PATH ?? '' },
      cleanupTimeoutMs: 2000,
    },
    cwd,
    shellPath
  );
  port.postMessage(result);
  setImmediate(() => process.exit(result.passed ? 0 : 1));
} catch (error) {
  port.postMessage({ passed: false, error: error instanceof Error ? error.stack : String(error) });
  setImmediate(() => process.exit(1));
}
