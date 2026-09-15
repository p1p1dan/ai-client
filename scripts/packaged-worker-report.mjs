/**
 * What the packaged worker smoke has to have proved (T009 review, T028).
 *
 * The smoke helper runs inside a packaged app under Electron, so it cannot be
 * driven from a unit test on a development machine — the only thing that CAN be
 * checked here is the report it prints, and that is exactly where the gate used
 * to be thin. Keeping the verdict in a pure function lets
 * `scripts/__tests__/packaged-worker-report.test.mjs` feed it the reports a
 * broken build would produce, instead of waiting for a release to find out.
 *
 * Every rule answers "which way could a packaged build be wrong and still
 * print something that looks fine":
 *
 *  - the run is a native run, stated by the trace the runtime itself wrote;
 *  - the worker was a real process that exited 0 on `worker.dispose` — a hung
 *    or killed worker is the failure a user sees as "the app will not close";
 *  - the executable matches the transport, so a Windows package that quietly
 *    forked Electron instead of the bundled Node is not reported as node-ipc;
 *  - the bootstrap result carries no `extensions` field. That was the legacy
 *    pi extension inventory; P6-5 retired the engine that produced it, and a
 *    result that grows it back means something reintroduced the old inventory
 *    path behind the panel's back (see cutover-03).
 */

/** Fields the smoke report must carry for the verdict below to mean anything. */
const REQUIRED_FIELDS = ['ok', 'stamp', 'workerPid', 'workerExecutable', 'exitCode', 'transport'];

export function expectedTransport(platform) {
  return platform === 'win32' ? 'node-ipc' : 'electron-message-port';
}

/**
 * @param report parsed JSON printed by `scripts/packaged-worker-smoke.cjs`
 * @param options.platform `process.platform` of the machine that ran the smoke
 * @returns human-readable failures; empty means the packaged worker is good
 */
export function evaluateWorkerSmokeReport(report, { platform }) {
  const failures = [];
  if (!report || typeof report !== 'object') return ['worker smoke returned no report'];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in report)) failures.push(`worker smoke report has no ${field}`);
  }
  if (report.ok !== true) failures.push(`worker smoke did not report ok: ${String(report.ok)}`);
  // Sourced from the run trace the native runtime itself wrote, not an echo of
  // an argument this script passed in — see cutover-01.
  if (report.stamp?.backend !== 'native') {
    failures.push(`worker smoke ran on backend ${String(report.stamp?.backend)}, not native`);
  }
  if (!Number.isSafeInteger(report.workerPid)) {
    failures.push(`worker smoke reported no usable pid: ${String(report.workerPid)}`);
  }
  // The dispose handshake, end to end: acknowledged, then a natural exit 0.
  if (report.exitCode !== 0) {
    failures.push(`packaged worker did not exit cleanly on dispose: ${String(report.exitCode)}`);
  }

  const transport = expectedTransport(platform);
  if (report.transport !== transport) {
    failures.push(`worker smoke used transport ${String(report.transport)}, expected ${transport}`);
  }
  const executable = report.workerExecutable;
  if (typeof executable !== 'string' || executable.trim() === '') {
    failures.push(`worker smoke named no worker executable: ${String(executable)}`);
  } else {
    const binary = executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
    const isNode = /^node(\.exe)?$/.test(binary);
    if (report.transport === 'node-ipc' && !isNode) {
      failures.push(`node-ipc worker ran on ${executable}, not the bundled Node runtime`);
    }
    if (report.transport === 'electron-message-port' && isNode) {
      failures.push(`utility-process worker ran on ${executable}, not the Electron binary`);
    }
  }

  const keys = report.bootstrapResultKeys;
  if (!Array.isArray(keys) || keys.length === 0) {
    failures.push('worker smoke reported no bootstrap result keys');
  } else if (keys.includes('extensions')) {
    failures.push('native bootstrap result carries a retired `extensions` inventory');
  }

  for (const tool of ['read', 'bash']) {
    if (!report.tools?.includes(tool)) failures.push(`worker smoke did not run the ${tool} tool`);
  }
  return failures;
}
