/** Addendum run — start the app and wait for the window. */
import { stamp, startApp, waitForWindow } from './lib.mjs';

const pid = startApp();
console.log(`[${stamp()}] dev.js pid=${pid}`);
console.log(`[${stamp()}] window:`, JSON.stringify(await waitForWindow()));
