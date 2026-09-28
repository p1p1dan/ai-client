// Offscreen screenshots of prototype.html: scenes A-E x light/dark, 1400x900.
//
// Run (from anywhere; no window is shown, no GPU, no network):
//   <worktree>/node_modules/electron/dist/electron --no-sandbox \
//     docs/plantree/plans/dsh-rebase/evidence/p1-7-prototype-2026-09-27/shoot.cjs
//
// Writes shots/<scene>-<slug>-<theme>.png and shots/measurements.json (the
// strip heights measured in the page by window.__measure()).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'p1-7-prototype-shoot'));

const here = __dirname;
const outDir = path.join(here, 'shots');
const SCENES = [
  ['A', 'three-strips-expanded'],
  ['B', 'three-strips-collapsed'],
  ['C', 'goal-paused-after-interject'],
  ['D', 'background-only-done-and-failed'],
  ['E', 'subagent-list-in-run-panel'],
];
const THEMES = ['light', 'dark'];

function nextPaint(wc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no paint within timeout')), timeoutMs);
    wc.once('paint', (_event, _dirty, image) => {
      clearTimeout(timer);
      resolve(image);
    });
    wc.invalidate();
  });
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(10);

  const results = [];
  try {
    for (const theme of THEMES) {
      for (const [scene, slug] of SCENES) {
        await win.loadFile(path.join(here, 'prototype.html'), {
          query: { scene, theme, shot: '1' },
        });
        const measured = await win.webContents.executeJavaScript(
          'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400))).then(() => window.__measure())'
        );
        const image = await nextPaint(win.webContents);
        const file = `${scene}-${slug}-${theme}.png`;
        fs.writeFileSync(path.join(outDir, file), image.toPNG());
        results.push({ file, size: image.getSize(), ...measured });
        console.log(`${file} ${JSON.stringify(image.getSize())} added=${measured.addedPx}px`);
      }
    }
    fs.writeFileSync(
      path.join(outDir, 'measurements.json'),
      `${JSON.stringify(results, null, 2)}\n`
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
