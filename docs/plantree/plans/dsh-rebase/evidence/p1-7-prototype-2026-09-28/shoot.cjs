// Offscreen screenshots of prototype.html: the 6 required scenarios (light +
// dark), supplementary shots for the goal-state gallery, the floating /
// embedded / docked form comparison, the two small-screen breakpoints
// (1280x720, 1024x640), and the two terminal positions (round 2).
//
// Run (from anywhere; no window is shown, no GPU, no network):
//   <worktree>/node_modules/electron/dist/electron --no-sandbox \
//     docs/plantree/plans/dsh-rebase/evidence/p1-7-prototype-2026-09-28/shoot.cjs
//
// Writes shots/<file>.png and shots/measurements.json (window.__measure()),
// which includes each open sub-window's geometry plus three pass/fail-worthy
// checks:
//   - overlapsDock          sub-window bottom edge crosses the composer's top
//   - headerOverflow        a header row's children spill past the card
//                            (coordinator round 2, defect 1)
//   - coversMessages        which timeline message elements the sub-window's
//                            rect visually intersects (defect 2). Expected
//                            (and NOT a failure) for `floating`/the docked
//                            fallback; a real bug for `embedded`/`docked`
//                            proper, which promise not to overlay anything.
// The script fails (non-zero exit) on overlapsDock, headerOverflow, or
// unexpected (non-floating) message coverage; plain floating-form coverage is
// only logged, per the README's documented trade-off.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'p1-7-prototype-shoot-2026-09-28'));

const here = __dirname;
const outDir = path.join(here, 'shots');

// window pixel size per `size` preset (must match prototype.html's SIZES map)
const SIZE_PX = { 1440: [1440, 900], 1280: [1280, 720], 1024: [1024, 640] };

const SHOTS = [
  { file: 'A-empty-light.png', q: { scene: 'A', theme: 'light' } },
  { file: 'A-empty-dark.png', q: { scene: 'A', theme: 'dark' } },
  { file: 'B-strips-collapsed-light.png', q: { scene: 'B', theme: 'light' } },
  { file: 'B-strips-collapsed-dark.png', q: { scene: 'B', theme: 'dark' } },
  {
    file: 'B-strips-expanded-light.png',
    q: { scene: 'B', theme: 'light', openTodo: '1', openGoal: '1' },
  },
  {
    file: 'B-goal-blocked-light.png',
    q: { scene: 'B', theme: 'light', goal: 'blocked', openGoal: '1' },
  },
  { file: 'C-jobs-floating-light.png', q: { scene: 'C', theme: 'light' } },
  { file: 'C-jobs-floating-dark.png', q: { scene: 'C', theme: 'dark' } },
  { file: 'D-agents-floating-light.png', q: { scene: 'D', theme: 'light' } },
  { file: 'D-agents-floating-dark.png', q: { scene: 'D', theme: 'dark' } },
  { file: 'E-both-floating-light.png', q: { scene: 'E', theme: 'light' } },
  { file: 'E-both-floating-dark.png', q: { scene: 'E', theme: 'dark' } },
  { file: 'E-both-embedded-light.png', q: { scene: 'E', theme: 'light', form: 'embedded' } },
  { file: 'E-both-embedded-dark.png', q: { scene: 'E', theme: 'dark', form: 'embedded' } },
  { file: 'E-both-floating-1280x720-light.png', q: { scene: 'E', theme: 'light', size: '1280' } },
  { file: 'E-both-floating-1024x640-light.png', q: { scene: 'E', theme: 'light', size: '1024' } },
  { file: 'F-terminal-light.png', q: { scene: 'F', theme: 'light' } },
  { file: 'F-terminal-dark.png', q: { scene: 'F', theme: 'dark' } },
  // --- round 2 additions ---
  // Variant 1: docked-right. At 1440 the centre column has room (1116px >=
  // 720 timeline + 300 panel + 16 gap = 1036px) so this renders the real
  // docked layout; at 1280 (956px) and 1024 (700px) it does not, so these
  // three shots are expected to show the automatic floating fallback (with
  // its inline "space not enough" note) — see the README for the exact math.
  { file: 'E-both-docked-light.png', q: { scene: 'E', theme: 'light', form: 'docked' } },
  { file: 'E-both-docked-dark.png', q: { scene: 'E', theme: 'dark', form: 'docked' } },
  {
    file: 'E-both-docked-1280x720-light.png',
    q: { scene: 'E', theme: 'light', form: 'docked', size: '1280' },
  },
  {
    file: 'E-both-docked-1280x720-dark.png',
    q: { scene: 'E', theme: 'dark', form: 'docked', size: '1280' },
  },
  {
    file: 'E-both-docked-1024x640-light.png',
    q: { scene: 'E', theme: 'light', form: 'docked', size: '1024' },
  },
  // Variant 2: terminal as a whole-column switch (1.0.x GUI/TUI shape).
  { file: 'F-terminal-column-light.png', q: { scene: 'F', theme: 'light', termpos: 'column' } },
  { file: 'F-terminal-column-dark.png', q: { scene: 'F', theme: 'dark', termpos: 'column' } },
];

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
  const results = [];
  // One persistent offscreen window, resized per shot via setContentSize.
  // (destroying + recreating a BrowserWindow between shots raced with
  // Electron's offscreen renderer and produced ERR_FAILED loads.)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(10);
  try {
    for (const shot of SHOTS) {
      const size = shot.q.size || '1440';
      const [w, h] = SIZE_PX[size];
      const [cw, ch] = win.getContentSize();
      if (cw !== w || ch !== h) {
        win.setContentSize(w, h);
      }
      await win.loadFile(path.join(here, 'prototype.html'), { query: { ...shot.q, shot: '1' } });
      const measured = await win.webContents.executeJavaScript(
        'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400))).then(() => window.__measure())'
      );
      const image = await nextPaint(win.webContents);
      fs.writeFileSync(path.join(outDir, shot.file), image.toPNG());
      const entry = { file: shot.file, size: image.getSize(), ...measured };
      results.push(entry);
      const flags = [
        measured.anyOverlap && 'OVERLAP!',
        measured.anyHeaderOverflow && 'HEADER-OVERFLOW!',
        measured.anyMessageCoveredUnexpected && 'UNEXPECTED-COVER!',
        measured.anyMessageCovered &&
          !measured.anyMessageCoveredUnexpected &&
          'covers-messages(floating, expected)',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `${shot.file} ${JSON.stringify(image.getSize())} addedPx=${measured.addedPx}${flags ? ' ' + flags : ''}`
      );
    }
    fs.writeFileSync(
      path.join(outDir, 'measurements.json'),
      `${JSON.stringify(results, null, 2)}\n`
    );
    const overlaps = results.filter((r) => r.anyOverlap);
    const headerOverflows = results.filter((r) => r.anyHeaderOverflow);
    const unexpectedCovers = results.filter((r) => r.anyMessageCoveredUnexpected);
    if (overlaps.length)
      console.error(`OVERLAP DETECTED in: ${overlaps.map((r) => r.file).join(', ')}`);
    if (headerOverflows.length)
      console.error(
        `HEADER OVERFLOW DETECTED in: ${headerOverflows.map((r) => r.file).join(', ')}`
      );
    if (unexpectedCovers.length)
      console.error(
        `UNEXPECTED MESSAGE COVERAGE (non-floating form) in: ${unexpectedCovers.map((r) => r.file).join(', ')}`
      );
    if (overlaps.length || headerOverflows.length || unexpectedCovers.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
