/**
 * App control: `node ij-app.mjs start [openPath] [envFile]` (waits for the window)
 *            | `node ij-app.mjs stop` | `node ij-app.mjs ps`.
 */
import { appProcesses, stamp, startApp, stopApp, waitForWindow, workerPids } from './ij-lib.mjs';

const [cmd, openPath, envFile] = process.argv.slice(2);
if (cmd === 'start') {
  const pid = startApp({ ...(openPath ? { openPath } : {}), ...(envFile ? { envFile } : {}) });
  console.log(
    `[${stamp()}] dev.js pid=${pid} openPath=${openPath ?? '(default)'} envFile=${envFile ?? '(default)'}`
  );
  console.log(`[${stamp()}] window:`, JSON.stringify(await waitForWindow()));
} else if (cmd === 'stop') {
  console.log(JSON.stringify(await stopApp(), null, 1));
} else {
  console.log(JSON.stringify({ app: appProcesses(), workers: workerPids() }, null, 1));
}
