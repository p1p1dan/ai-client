// Offscreen screenshots of prototype.html: the 6 required scenarios (light +
// dark), supplementary shots for the goal-state gallery, the floating /
// embedded / docked form comparison, the two small-screen breakpoints
// (1280x720, 1024x640), the two (retired) terminal positions (round 2), and
// scene G's right-column terminal (decision 109).
//
// Run (from anywhere; no window is shown, no GPU, no network):
//   <worktree>/node_modules/electron/dist/electron --no-sandbox \
//     docs/plantree/plans/dsh-rebase/evidence/p1-7-prototype-2026-09-28/shoot.cjs
//
// To shoot only a subset of scenes (e.g. re-shooting just the new scene G
// instead of all ~28 shots on this 2-core/3.3GB box), set SHOOT_SCENES to a
// comma-separated list of scene letters:
//   SHOOT_SCENES=G <worktree>/node_modules/electron/dist/electron --no-sandbox \
//     docs/plantree/plans/dsh-rebase/evidence/p1-7-prototype-2026-09-28/shoot.cjs
//
// Writes shots/<file>.png for whichever shots ran, and shots/measurements.json
// (window.__measure()) merged by `file` key with whatever was already there —
// a partial (SHOOT_SCENES) run only updates the entries it actually shot and
// leaves every other scene's recorded measurements untouched.
//
// measurements.json includes each open sub-window's geometry plus pass/fail
// worthy checks:
//   - overlapsDock          sub-window bottom edge crosses the composer's top
//   - headerOverflow        a header row's children spill past the card
//                            (coordinator round 2, defect 1); also true when
//                            scene G's right-column terminal header overflows
//   - coversMessages        which timeline message elements the sub-window's
//                            rect visually intersects (defect 2). Expected
//                            (and NOT a failure) for `floating`/the docked
//                            fallback; a real bug for `embedded`/`docked`
//                            proper, which promise not to overlay anything.
//   - overlapsRightColumn   (decision 109 / scene G) sub-window rect
//                            intersects the right-column terminal's rect —
//                            expected to always be false (the two live in
//                            disjoint flex boxes), verified rather than
//                            assumed.
//   - sessionbarOverlapsRightColumn (coordinator round 3, defects 1/2) any
//                            sessionbar control's own box intersects the
//                            right column's title row — a different failure
//                            mode from `headerOverflow` (that judge checks
//                            whether an element overflows ITS OWN box;
//                            round 3's bug was an unshrinkable sessionbar
//                            title pushing a neighbour's box past the chat
//                            column's edge, which `headerOverflow` cannot
//                            see). Verified true on the pre-fix markup and
//                            false after, see README "场景 G".
// The script fails (non-zero exit) on overlapsDock, headerOverflow,
// unexpected (non-floating) message coverage, overlapsRightColumn, or
// sessionbarOverlapsRightColumn; plain floating-form message coverage is only
// logged, per the README's documented
// trade-off.
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
  // --- decision 109: scene G, right-column terminal (supersedes F) ---
  // Both floating sub-windows are also open in every G shot (scene G's
  // default `open`) — this is the worst-case combination for checking
  // whether they and the new right column fight over space.
  { file: 'G-terminal-light.png', q: { scene: 'G', theme: 'light' } },
  { file: 'G-terminal-dark.png', q: { scene: 'G', theme: 'dark' } },
  { file: 'G-terminal-1280x720-light.png', q: { scene: 'G', theme: 'light', size: '1280' } },
];

// Optional partial run: SHOOT_SCENES=G,E restricts to shots whose `scene`
// query matches. Absent, every shot in SHOTS runs (full re-shoot).
const sceneFilter = process.env.SHOOT_SCENES
  ? new Set(
      process.env.SHOOT_SCENES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  : null;
const ACTIVE_SHOTS = sceneFilter ? SHOTS.filter((s) => sceneFilter.has(s.q.scene)) : SHOTS;

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
    if (sceneFilter) {
      console.log(
        `SHOOT_SCENES=${[...sceneFilter].join(',')} — shooting ${ACTIVE_SHOTS.length}/${SHOTS.length} shots`
      );
    }
    for (const shot of ACTIVE_SHOTS) {
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
        measured.anyOverlapsRightColumn && 'OVERLAPS-RIGHT-COLUMN!',
        measured.sessionbarOverlapsRightColumn && 'SESSIONBAR-OVERLAPS-RIGHT-COLUMN!',
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
    // Merge by `file` key rather than overwrite: a partial (SHOOT_SCENES) run
    // must not wipe out every other scene's previously recorded measurements.
    // Order follows the full SHOTS list so the file stays a stable diff even
    // when only a subset was re-shot; any stray entry no longer in SHOTS is
    // appended rather than silently dropped.
    const measurementsPath = path.join(outDir, 'measurements.json');
    let existing = [];
    if (fs.existsSync(measurementsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(measurementsPath, 'utf8'));
      } catch {
        existing = [];
      }
    }
    const byFile = new Map(existing.map((r) => [r.file, r]));
    for (const r of results) byFile.set(r.file, r);
    const merged = SHOTS.map((s) => byFile.get(s.file)).filter(Boolean);
    for (const r of existing) {
      if (!SHOTS.some((s) => s.file === r.file)) merged.push(r);
    }
    fs.writeFileSync(measurementsPath, `${JSON.stringify(merged, null, 2)}\n`);
    const overlaps = merged.filter((r) => r.anyOverlap);
    const headerOverflows = merged.filter((r) => r.anyHeaderOverflow);
    const unexpectedCovers = merged.filter((r) => r.anyMessageCoveredUnexpected);
    const rightColumnOverlaps = merged.filter((r) => r.anyOverlapsRightColumn);
    const sessionbarOverlaps = merged.filter((r) => r.sessionbarOverlapsRightColumn);
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
    if (rightColumnOverlaps.length)
      console.error(
        `RIGHT-COLUMN OVERLAP (decision 109) in: ${rightColumnOverlaps.map((r) => r.file).join(', ')}`
      );
    if (sessionbarOverlaps.length)
      console.error(
        `SESSIONBAR OVERLAPS RIGHT COLUMN (coordinator round 3) in: ${sessionbarOverlaps.map((r) => r.file).join(', ')}`
      );
    if (
      overlaps.length ||
      headerOverflows.length ||
      unexpectedCovers.length ||
      rightColumnOverlaps.length ||
      sessionbarOverlaps.length
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
