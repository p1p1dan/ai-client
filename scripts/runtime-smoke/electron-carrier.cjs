const { app, utilityProcess } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

const cwd = mkdtempSync(join(tmpdir(), 'p1-electron-'));
let child;
let report;
let finished = false;
const timer = setTimeout(() => finish(1, { passed: false, error: 'carrier probe timeout' }), 30000);
function finish(code, failure) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (failure) report = failure;
  child?.kill();
  rmSync(cwd, { recursive: true, force: true });
  console.log(
    `P1_CARRIER_REPORT ${JSON.stringify(report ?? { passed: false, error: 'worker exited without report' })}`
  );
  app.exit(code);
}
app
  .whenReady()
  .then(() => {
    child = utilityProcess.fork(
      resolve(__dirname, '../../src/runtime/smoke/p1-utility-worker.ts'),
      [cwd, ...process.argv.slice(-2)],
      { stdio: 'pipe', execArgv: ['--experimental-strip-types', '--max-old-space-size=768'] }
    );
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('message', (message) => {
      report = message;
    });
    child.on('exit', (code) => finish(code === 0 && report?.passed ? 0 : 1));
  })
  .catch((error) => finish(1, { passed: false, error: error.message }));
