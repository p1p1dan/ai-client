import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluateWorkerSmokeReport, expectedTransport } from '../packaged-worker-report.mjs';

/**
 * The packaging gate's verdict, exercised where the gate itself cannot run.
 *
 * `verify-packaged-app.mjs` needs a packaged app and an Electron binary, so on a
 * development machine it is never executed and every assertion inside it is
 * unverified code. These cases feed the verdict function the reports a broken
 * package would print — that is the whole point of having split it out.
 */

/** A report from a healthy Linux/macOS package (utility process carrier). */
function utilityReport(overrides = {}) {
  return {
    ok: true,
    backend: 'native',
    workerPath: '/opt/AiClient/resources/agent-host/worker.js',
    workerExecutable: '/opt/AiClient/aiclient',
    stamp: { backend: 'native', carrier: 'electron-utility' },
    exitCode: 0,
    workerPid: 4242,
    transport: 'electron-message-port',
    bootstrapResultKeys: ['agentDir', 'bootstrapped', 'capabilities', 'leaf', 'permissionGate'],
    tools: ['read', 'bash'],
    ...overrides,
  };
}

/** A report from a healthy Windows package (bundled Node carrier). */
function nodeReport(overrides = {}) {
  return utilityReport({
    workerExecutable: 'C:\\Program Files\\AiClient\\resources\\node-runtime\\node.exe',
    stamp: { backend: 'native', carrier: 'bundled-node' },
    transport: 'node-ipc',
    ...overrides,
  });
}

describe('packaged worker smoke verdict', () => {
  it('accepts a healthy report on each carrier', () => {
    expect(evaluateWorkerSmokeReport(utilityReport(), { platform: 'linux' })).toEqual([]);
    expect(evaluateWorkerSmokeReport(nodeReport(), { platform: 'win32' })).toEqual([]);
    expect(expectedTransport('win32')).toBe('node-ipc');
    expect(expectedTransport('darwin')).toBe('electron-message-port');
  });

  it('rejects a bootstrap result that carries a retired extensions inventory', () => {
    // T009's review item: P6-5 retired the pi extension inventory, so a native
    // bootstrap result that grows `extensions` back means the old inventory
    // path returned behind the panel's back.
    const report = utilityReport({
      bootstrapResultKeys: ['bootstrapped', 'extensions', 'permissionGate'],
    });
    expect(evaluateWorkerSmokeReport(report, { platform: 'linux' })).toEqual([
      'native bootstrap result carries a retired `extensions` inventory',
    ]);
  });

  it('rejects a worker that did not exit cleanly on dispose', () => {
    expect(
      evaluateWorkerSmokeReport(utilityReport({ exitCode: 1 }), { platform: 'linux' })
    ).toContain('packaged worker did not exit cleanly on dispose: 1');
    // A helper too old to report the exit at all must not pass either.
    const { exitCode: _dropped, ...withoutExit } = utilityReport();
    expect(evaluateWorkerSmokeReport(withoutExit, { platform: 'linux' })).toContain(
      'worker smoke report has no exitCode'
    );
  });

  it('rejects an executable that does not match the transport', () => {
    // A Windows package that forked Electron instead of the bundled Node still
    // completes a turn — and is not the thing that ships.
    expect(
      evaluateWorkerSmokeReport(nodeReport({ workerExecutable: 'C:\\x\\AiClient.exe' }), {
        platform: 'win32',
      })
    ).toContain('node-ipc worker ran on C:\\x\\AiClient.exe, not the bundled Node runtime');
    expect(
      evaluateWorkerSmokeReport(utilityReport({ workerExecutable: '/usr/bin/node' }), {
        platform: 'linux',
      })
    ).toContain('utility-process worker ran on /usr/bin/node, not the Electron binary');
    expect(
      evaluateWorkerSmokeReport(utilityReport({ workerExecutable: '' }), { platform: 'linux' })
    ).toContain('worker smoke named no worker executable: ');
  });

  it('still rejects the failures the gate already covered', () => {
    expect(
      evaluateWorkerSmokeReport(utilityReport({ ok: false }), { platform: 'linux' })
    ).toContain('worker smoke did not report ok: false');
    expect(
      evaluateWorkerSmokeReport(utilityReport({ stamp: { backend: 'legacy' } }), {
        platform: 'linux',
      })
    ).toContain('worker smoke ran on backend legacy, not native');
    expect(
      evaluateWorkerSmokeReport(utilityReport({ workerPid: null }), { platform: 'linux' })
    ).toContain('worker smoke reported no usable pid: null');
    expect(
      evaluateWorkerSmokeReport(utilityReport({ tools: ['read'] }), { platform: 'linux' })
    ).toContain('worker smoke did not run the bash tool');
    // The Windows report evaluated on Linux: right package, wrong machine.
    expect(evaluateWorkerSmokeReport(nodeReport(), { platform: 'linux' })).toContain(
      'worker smoke used transport node-ipc, expected electron-message-port'
    );
    expect(evaluateWorkerSmokeReport(null, { platform: 'linux' })).toEqual([
      'worker smoke returned no report',
    ]);
  });

  it('refuses a report with no bootstrap result keys, and the helper does send them', () => {
    // Guards the guard from both ends: a report without the key names must not
    // pass, and the helper that produces the report must still be sending them
    // — otherwise the `extensions` rule above checks nothing in a real build.
    const { bootstrapResultKeys: _dropped, ...withoutKeys } = utilityReport();
    expect(evaluateWorkerSmokeReport(withoutKeys, { platform: 'linux' })).toEqual([
      'worker smoke reported no bootstrap result keys',
    ]);
    const helper = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packaged-worker-smoke.cjs'),
      'utf8'
    );
    expect(helper).toContain('bootstrapResultKeys: Object.keys(bootstrap.result).sort()');
  });
});
