/**
 * The one gateway both clients talk to. `fake`: the local fake gateway
 * (tools/fake-gateway.mjs, plan `ab-eval`) on 127.0.0.1, playing each case's
 * scripted model, with a throwaway key. `real`: AB_BASE_URL and AB_API_KEY
 * from this process's environment, never written anywhere: records carry a
 * hash of the URL, and the URL, its host and the key are redacted from
 * every file the harness writes.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedCase } from './types.ts';

export interface Gateway {
  kind: 'fake' | 'real';
  /** Root URL, without `/v1`: both clients append their own path. */
  baseUrl: string;
  apiKey: string;
  /** `sha256:<12 hex>` of the base URL, for records. */
  id: string;
  /** Strings no persisted file may contain. */
  secrets: string[];
  /** The fake gateway's request log and request captures (scratch), when fake. */
  logFile?: string;
  captureDir?: string;
  stop(): Promise<void>;
}

export function gatewayId(baseUrl: string): string {
  return `sha256:${createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}`;
}

/** AB_BASE_URL / AB_API_KEY, or an error saying they are missing. */
export function realGateway(): Gateway {
  const baseUrl = process.env.AB_BASE_URL?.trim().replace(/\/+$/, '');
  const apiKey = process.env.AB_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error('--gateway real needs AB_BASE_URL and AB_API_KEY in the environment');
  }
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error('AB_BASE_URL is not a URL');
  }
  return {
    kind: 'real',
    baseUrl,
    apiKey,
    id: gatewayId(baseUrl),
    secrets: [apiKey, baseUrl, host].filter((item) => item.length >= 6),
    stop: async () => {},
  };
}

/** The scripts the `ab-eval` plan plays: one per case that has a fake model. */
export function writeFakeScripts(cases: readonly LoadedCase[], file: string): number {
  const scripts = cases
    .filter((c) => c.fakeModel)
    .map((c) => ({ id: c.id, match: c.prompt, steps: c.fakeModel?.steps ?? [] }));
  writeFileSync(file, `${JSON.stringify({ scripts }, null, 2)}\n`);
  return scripts.length;
}

async function waitPort(child: ChildProcess): Promise<number> {
  return new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fake gateway exited (${code}) before listening`));
    });
  });
}

/** The fake gateway on an ephemeral port, its log and captures under `dir` (a scratch directory). */
export async function startFakeGateway(options: {
  entry: string;
  dir: string;
  cases: readonly LoadedCase[];
  model: string;
  capture: boolean;
}): Promise<Gateway> {
  mkdirSync(options.dir, { recursive: true });
  const scripts = join(options.dir, 'ab-scripts.json');
  writeFakeScripts(options.cases, scripts);
  const logFile = join(options.dir, 'gateway.jsonl');
  const captureDir = options.capture ? join(options.dir, 'capture') : undefined;
  const child = spawn(
    process.execPath,
    [
      options.entry,
      '--port',
      '0',
      '--plan',
      'ab-eval',
      '--ab-scripts',
      scripts,
      '--reset',
      '--state',
      join(options.dir, 'gateway.state.json'),
      '--log',
      logFile,
      '--model-id',
      options.model,
      ...(captureDir ? ['--capture', captureDir] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  child.stderr?.resume();
  const port = await waitPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiKey = `ab-eval-fake-${randomBytes(12).toString('hex')}`;
  return {
    kind: 'fake',
    baseUrl,
    apiKey,
    id: gatewayId('fake'),
    secrets: [apiKey],
    logFile,
    ...(captureDir ? { captureDir } : {}),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
