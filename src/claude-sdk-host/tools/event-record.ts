/**
 * Route B S-5 (docs/plantree/plans/claude-sdk-engine/topics/s5-regression.md R-3): the
 * recorded-event gate of the Claude Agent SDK engine, after DSH's `bridge-record.ts`.
 *
 *   node tools/event-record.ts [--check | --update] [--only text,tools] [--out-dir <dir>]
 *
 * Runs the deterministic probe scenarios against a local fake gateway it starts itself,
 * normalizes each scenario's runtime events (`event-normalize.ts`) and compares them with
 * the samples in src/shared/__tests__/fixtures/claude-sdk/stream.<scenario>.json; exits 1
 * on any difference. `--update` rewrites the samples instead: only when a change of the
 * host, the SDK or the CLI is meant to change what the renderer receives, and a person
 * reads the diff. `--out-dir` also writes the normalized recordings there (repeat runs, to
 * judge determinism). Only the fake gateway is used.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRecording, type RawRecording } from './event-normalize.ts';
import { freePort, groupPassed, readProbeOutput, run, waitForHealth } from './probe-suite.ts';

/** The scenarios whose events do not depend on timing (the fake gateway's own scripts). */
export const RECORDED_SCENARIOS = ['text', 'tools', 'ask', 'plan'] as const;

/**
 * A sample as the recorder writes it, whatever a formatter made of the committed file
 * (the commit hook reflows JSON): the gate compares content, not layout.
 */
export function canonicalSample(text: string): string {
  return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
}

/** The first difference between two normalized recordings, as lines a person can read. */
export function firstDifference(expected: string, actual: string): string | null {
  if (expected === actual) return null;
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n  expected: ${a[i] ?? '(end)'}\n  recorded: ${b[i] ?? '(end)'}`;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let update = process.env.AICLIENT_UPDATE_FIXTURES === '1';
  let only: string[] | null = null;
  let outDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--update') update = true;
    else if (argv[i] === '--check') update = false;
    else if (argv[i] === '--only') only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (argv[i] === '--out-dir') outDir = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const scenarios = only
    ? RECORDED_SCENARIOS.filter((s) => only?.includes(s))
    : [...RECORDED_SCENARIOS];
  if (only && scenarios.length !== only.length) {
    throw new Error(`unknown scenario in --only; recorded are ${RECORDED_SCENARIOS.join(', ')}`);
  }
  const here = fileURLToPath(new URL('.', import.meta.url));
  const hostDir = join(here, '..');
  const fixtures = join(here, '..', '..', 'shared', '__tests__', 'fixtures', 'claude-sdk');
  const base = mkdtempSync(join(tmpdir(), 'pilab-record-'));
  const workspace = join(base, 'ws');
  const config = join(base, 'config');
  const rawDir = join(base, 'raw');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(config, { recursive: true });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const gateway = spawn(
    process.execPath,
    [
      join(here, '..', '..', 'dsh-host', 'tools', 'fake-gateway.mjs'),
      '--port',
      String(port),
      '--plan',
      'claude-sdk',
      '--reset',
      '--model-id',
      'claude-opus-5-5',
      '--state',
      join(base, 'gw-state.json'),
      '--log',
      join(base, 'gw.log'),
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  let failed = false;
  try {
    await waitForHealth(url, 15_000);
    const log = join(base, 'probe.log');
    const exit = await run(
      process.execPath,
      [join(here, 'host-probe.ts'), url, workspace, ...scenarios],
      {
        cwd: hostDir,
        env: { ...process.env, PROBE_CONFIG_DIR: config, PROBE_RECORD_DIR: rawDir },
        log,
        timeoutMs: 15 * 60_000,
      }
    );
    const probe = readProbeOutput(readFileSync(log, 'utf8'));
    if (!groupPassed({ exit, ...probe })) {
      console.error(
        `[event-record] the probe run failed (${probe.summary ?? `exit ${exit}`}); log: ${log}`
      );
      failed = true;
      return;
    }
    if (update) mkdirSync(fixtures, { recursive: true });
    if (outDir) mkdirSync(outDir, { recursive: true });
    for (const scenario of scenarios) {
      const raw = JSON.parse(
        readFileSync(join(rawDir, `raw.${scenario}.json`), 'utf8')
      ) as RawRecording;
      const recorded = `${JSON.stringify(normalizeRecording(raw), null, 2)}\n`;
      const sample = join(fixtures, `stream.${scenario}.json`);
      if (outDir) writeFileSync(join(outDir, `stream.${scenario}.json`), recorded);
      if (update) {
        writeFileSync(sample, recorded);
        console.log(`[event-record] wrote ${sample}`);
        continue;
      }
      const expected = existsSync(sample) ? canonicalSample(readFileSync(sample, 'utf8')) : '';
      const difference = expected
        ? firstDifference(expected, recorded)
        : 'no sample yet (run --update)';
      console.log(`[event-record] ${difference ? 'DIFF' : 'ok  '} ${scenario}`);
      if (difference) {
        failed = true;
        console.log(difference.replace(/^/gm, '    '));
      }
    }
  } finally {
    gateway.kill();
    if (!failed) rmSync(base, { recursive: true, force: true });
    else console.error(`[event-record] kept ${base}`);
  }
  process.exitCode = failed ? 1 : 0;
}

// Run as a script, not when a test imports `firstDifference`.
const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
  main().catch((error) => {
    console.error('[event-record] failed:', error);
    process.exitCode = 1;
  });
}
