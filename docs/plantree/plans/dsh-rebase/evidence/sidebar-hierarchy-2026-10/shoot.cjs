// Offscreen screenshots of prototype.html (issue #3, sidebar hierarchy) plus the
// page's window.__measure() hard criteria. Same offscreen-Electron approach as
// ../p1-7-prototype-2026-09-28/shoot.cjs: no window shown, no GPU, scale 1.
//
// Run (2-core / 3.3 GB box: check `free -m` first, run nothing else alongside):
//   W=<worktree root>
//   "$W/node_modules/electron/dist/electron" --no-sandbox --disable-gpu \
//     "$W/docs/plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/shoot.cjs"
//
// Optional: SHOOT_ONLY=02,08 shoots only the shots whose file name starts with
// one of those prefixes; measurements.json is merged by file name.
//
// Writes shots/<file>.png and shots/../measurements.json. Exit code is non-zero
// when any 方案 (proposal) root fails a hard criterion:
//   noRowOverflow     nothing spills out of a row's content box
//   recentAtMostOnce  a chat appears at most once inside 「最近」, every 「最近」
//                     row is also in its folder, and 「查看更多（N）」 counts
//                     the rows left after dedupe
//   levelFonts        L0–L4 text uses only 14/15px and 400/600 (buttons and
//                     badges excluded; 400/700 under the CJK/Win10 simulation)
//   noSmallCjk        no CJK text under 14px anywhere in the panel
//   sameDepthX        titles at the same depth share one x coordinate
//   titleWidth160     (280px only) rows in folders without context text or
//                     alert badges keep a title >= 160px; all others >= 80px
//   sticky            (scrolled shots) the header of the section crossing the
//                     viewport top sits exactly on the viewport top
//   carriers          every pair of adjacent levels differs in >= 2 carriers
// 现状 (current) roots are measured with the same code; their failures are the
// point of the comparison and are reported, not enforced.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'sidebar-hierarchy-shoot-2026-10'));

const here = __dirname;
const outDir = path.join(here, 'shots');
const measurementsPath = path.join(here, 'measurements.json');

const SHOTS = [
  { file: '01-current-280-light.png', q: { mode: 'current' } },
  { file: '02-proposal-280-light.png', q: { mode: 'proposal' } },
  { file: '03-compare-280-light.png', q: { mode: 'compare' } },
  { file: '04-proposal-280-dark.png', q: { mode: 'proposal', theme: 'dark' } },
  { file: '05-current-280-dark.png', q: { mode: 'current', theme: 'dark' } },
  { file: '06-proposal-360-light.png', q: { mode: 'proposal', w: '360' } },
  { file: '07-proposal-500-light.png', q: { mode: 'proposal', w: '500' } },
  { file: '08-proposal-280-scrolled-sticky.png', q: { mode: 'proposal', scroll: 'mid' } },
  { file: '09-current-280-scrolled.png', q: { mode: 'current', scroll: 'mid' } },
  { file: '10-proposal-280-recent-collapsed.png', q: { mode: 'proposal', recent: 'collapsed' } },
  { file: '11-proposal-280-variant-B.png', q: { mode: 'proposal', l1: 'B' } },
  {
    file: '12-proposal-280-temp-X-bottom.png',
    q: { mode: 'proposal', temp: 'X', scroll: 'bottom' },
  },
  {
    file: '13-proposal-280-temp-Y-bottom.png',
    q: { mode: 'proposal', temp: 'Y', scroll: 'bottom' },
  },
  { file: '14-compare-280-cjk-win.png', q: { mode: 'compare', cjk: '1' } },
  { file: '15-proposal-280-guides-tooltip.png', q: { mode: 'proposal', guides: '1', tip: '1' } },
  { file: '16-proposal-280-select-mode.png', q: { mode: 'proposal', select: '1' } },
  { file: '17-current-280-full-length.png', q: { mode: 'current', tall: '1' } },
  { file: '18-proposal-280-full-length.png', q: { mode: 'proposal', tall: '1' } },
];

const HARD = [
  'noRowOverflow',
  'recentAtMostOnce',
  'levelFonts',
  'noSmallCjk',
  'sameDepthX',
  'titleWidth160',
  'sticky',
  'carriers',
];

const only = process.env.SHOOT_ONLY
  ? process.env.SHOOT_ONLY.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const ACTIVE = only ? SHOTS.filter((s) => only.some((p) => s.file.startsWith(p))) : SHOTS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextPaint(wc, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no paint within timeout')), timeoutMs);
    wc.once('paint', (_event, _dirty, image) => {
      clearTimeout(timer);
      resolve(image);
    });
    wc.invalidate();
  });
}

// Fallback for pages taller than the window manager allows: scroll the page and
// stack the segments. BGRA rows are contiguous, so stacking is concatenation.
async function stitch(wc, w, h) {
  const parts = [];
  let y = 0;
  let segH = 0;
  while (y < h) {
    const probe = await nextPaint(wc);
    segH = probe.getSize().height;
    const scrollY = Math.min(y, h - segH);
    await wc.executeJavaScript(
      `window.scrollTo(0, ${scrollY}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`
    );
    await sleep(150);
    const img = await nextPaint(wc);
    const { width, height } = img.getSize();
    if (width !== w) throw new Error(`stitch: width ${width} != ${w}`);
    const bmp = img.toBitmap();
    const skip = y - scrollY;
    const take = Math.min(height - skip, h - y);
    parts.push(Buffer.from(bmp.subarray(skip * width * 4, (skip + take) * width * 4)));
    y += take;
  }
  await wc.executeJavaScript('window.scrollTo(0, 0)');
  return nativeImage.createFromBitmap(Buffer.concat(parts), { width: w, height: h });
}

function failedHard(root) {
  return HARD.filter((k) => {
    const c = root.checks[k];
    if (!c || c.applicable === false || c.info) return false;
    return !c.pass;
  });
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const win = new BrowserWindow({
    width: 900,
    height: 940,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(10);
  win.webContents.on('console-message', (event, _level, message) => {
    console.log(`[page] ${message ?? event.message}`);
  });
  let failures = 0;
  try {
    for (const shot of ACTIVE) {
      await win.loadFile(path.join(here, 'prototype.html'), { query: { ...shot.q, shot: '1' } });
      const size = await win.webContents.executeJavaScript(
        'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300))).then(() => window.__pageSize())'
      );
      const [cw, ch] = win.getContentSize();
      if (cw !== size.w || ch !== size.h) {
        win.setContentSize(size.w, size.h);
        await sleep(400);
      }
      const measured = await win.webContents.executeJavaScript('window.__measure()');
      let image = await nextPaint(win.webContents);
      const got = image.getSize();
      if (got.width !== size.w || got.height !== size.h) {
        console.log(
          `  window clamped to ${got.width}x${got.height}, stitching ${size.w}x${size.h}`
        );
        image = await stitch(win.webContents, size.w, size.h);
      }
      fs.writeFileSync(path.join(outDir, shot.file), image.toPNG());
      const entry = { file: shot.file, query: shot.q, image: image.getSize(), ...measured };
      results.push(entry);
      const flags = measured.roots
        .map((r) => {
          const bad = failedHard(r);
          if (r.mode === 'proposal' && bad.length) failures += 1;
          return `${r.mode}:${bad.length ? `FAIL(${bad.join(',')})` : 'ok'}`;
        })
        .join(' ');
      console.log(`${shot.file} ${JSON.stringify(image.getSize())} ${flags}`);
    }
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
    fs.writeFileSync(measurementsPath, `${JSON.stringify(merged, null, 2)}\n`);
    if (failures) {
      console.error(`${failures} shot(s) with a failing 方案 root`);
      process.exitCode = 1;
    } else {
      console.log('all 方案 roots pass every hard criterion');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
