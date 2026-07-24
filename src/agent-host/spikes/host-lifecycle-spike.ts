/**
 * Phase 0: start Agent Host stub via Node 24, handshake, shutdown, verify no orphan.
 *
 * Usage:
 *   node --experimental-strip-types spikes/host-lifecycle-spike.ts
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostEntry = path.resolve(__dirname, '..', 'index.ts');

interface Result {
  ok: boolean;
  hostPid?: number;
  sawReady: boolean;
  exitCode: number | null;
  orphanLikely: boolean;
  notes: string[];
  error?: string;
}

async function main(): Promise<void> {
  const notes: string[] = [];
  const result: Result = {
    ok: false,
    sawReady: false,
    exitCode: null,
    orphanLikely: false,
    notes,
  };

  notes.push(`node=${process.version}`);
  notes.push(`execPath=${process.execPath}`);
  notes.push(`hostEntry=${hostEntry}`);

  const child = spawn(process.execPath, ['--experimental-strip-types', hostEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  result.hostPid = child.pid;

  const rl = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for host.ready')), 5000);
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as { type?: string };
        notes.push(`event=${event.type}`);
        if (event.type === 'host.ready') {
          result.sawReady = true;
          clearTimeout(timer);
          resolve();
        }
      } catch {
        notes.push(`bad-line=${line.slice(0, 80)}`);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!result.sawReady) {
        clearTimeout(timer);
        reject(new Error(`host exited early code=${String(code)}`));
      }
    });
  });

  child.stderr.on('data', (c) => {
    notes.push(`stderr=${c.toString().trim().slice(0, 200)}`);
  });

  try {
    // initialize
    child.stdin.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: 'init-1',
        type: 'host.initialize',
        payload: { driver: 'agent-sdk' },
      })}\n`
    );
    await ready;

    // shutdown
    child.stdin.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: 'shutdown-1',
        type: 'host.shutdown',
      })}\n`
    );
    child.stdin.end();

    result.exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (c) => resolve(c));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(child.exitCode);
      }, 4000);
    });

    // Brief settle, then check if PID still exists (Windows).
    await new Promise((r) => setTimeout(r, 500));
    if (result.hostPid) {
      try {
        process.kill(result.hostPid, 0);
        result.orphanLikely = true;
        notes.push('PID still alive after exit — orphan risk');
      } catch {
        notes.push('PID gone after exit — good');
      }
    }

    result.ok = result.sawReady && result.exitCode === 0 && !result.orphanLikely;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

main();
