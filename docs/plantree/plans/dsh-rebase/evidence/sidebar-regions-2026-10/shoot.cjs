// Offscreen screenshots of prototype.html (issue #6: fixed sidebar regions, the
// 16 / 15 / 14 type ladder, a capped top region, "collapse all" and, from v2,
// the home page, the activity-ordered folders and the way back home) plus the
// page's window.__measure() hard criteria. Same offscreen-Electron approach as
// ../sidebar-hierarchy-2026-10/shoot.cjs: no window shown, no GPU, scale 1.
//
// Run (2-core / 3.3 GB box: check `free -m` first, run nothing else alongside):
//   W=<worktree root>
//   "$W/node_modules/electron/dist/electron" --no-sandbox --disable-gpu \
//     "$W/docs/plantree/plans/dsh-rebase/evidence/sidebar-regions-2026-10/shoot.cjs"
//
// Optional: SHOOT_ONLY=02,21 shoots only the shots whose file name starts with
// one of those prefixes; measurements.json is merged by file name.
//
// Shots 01-20 are v1 (2026-10-09). They pin v1's parameters (V1 below), so the
// page reproduces them unchanged; 21-31 are v2 (2026-10-10) and pin v2's home
// page (home=v2); 32-45 are v3 (2026-10-10, the home page with the real
// composer) and pin home=v3. v4 (2026-10-10) has no shots yet: the user asked
// for the page only, checks to run once the design is settled.
// 41 is a composite of 32 and 40 (the composer strip before and after the first
// send), built here from those two PNGs.
//
// Writes shots/<file>.png and measurements.json. Exit code is non-zero when a
// 方案 (proposal) root fails any hard criterion, or when the 现状 (dsh.8) root
// stops matching HEAD on a fidelity criterion (a prototype bug):
//   shellChrome         list area = window height - 186 (title bar 32, panel
//                       title 36, toolbar + search 77, footer 41)
//   levelFonts          L0 16/600, L1 16/600, L2 15/600, L3 14/400, L4 14/400,
//                       session bar title 16/400 (现状: 15/600, 15/600, 15/600,
//                       15/400, 14/400, 15/400); 600 -> 700 under CJK / Win10
//   titleInk            chat titles use --foreground-soft (v2: equal to
//                       color-mix(in oklab, foreground 50%, muted-foreground)),
//                       the open row foreground; L1 and L2 stay foreground
//   regions             top region <= 33% and Temporary chats <= 25% of the
//                       list area (+1px), content-sized below the cap, the
//                       regions tile the list area exactly
//   regionsIndependent  scrolling the repository list moves nothing in the
//                       other regions
//   l1OutsideScroll     no L1 section title is inside a scroll viewport
//   recentSegments      (v1 / dsh.8) each segment's rows + 「查看更多（N）」 /
//                       「收起」, no chat twice, the lower segment holds no
//                       active chat (folded ones included)
//   activeRegion        (v2) 「正在活动」 shows <= 5 rows + 「查看更多（N）」,
//                       is the first region, and is gone (title included) when
//                       nothing is active
//   noLowerSegment      (v2) no 「48 小时内」 segment or segment label anywhere
//   folderOrder         v2: newest last activity first, folders without chats
//                       after them in their old order, 「临时工作区」 last;
//                       otherwise the order repositories were added
//   coordsKept          issue #3's x coordinates: L1 16, folder name 38,
//                       unnested title 38, in-folder title 50, time box right
//                       edge 16 from the right border
//   titleWidth160       (280px) in-folder rows without context text or alert
//                       badges keep a title >= 160px; all others >= 80px
//   noRowOverflow / noSmallCjk (whole window) / sameDepthX / carriers
//   reposHeaderButtons  collapse all, filter, add: 24px buttons, 14px icons
//   collapseAll         (when every folder is collapsed) no chat row under a
//                       folder, temporary chats untouched
//   home                (v2, nothing open) exactly 「新建对话」 (primary),
//                       「添加仓库」 (outline) and 「最近对话」 (10 rows +
//                       「查看更多（N）」, grouped 今天 / 昨天 / 更早), on the
//                       45rem reading column; the bar says 「首页」; no composer
//   homeEntry           (v2) the way back: (a) above 「聊天」 on the rail, 32px;
//                       (b) first in the panel toolbar row, nothing spilling
//   homeV3              (v3 home) no 「新建对话」 / 「添加仓库」 buttons; the title
//                       names the work bar's repository (without one: no
//                       workspace in the title, 「未选仓库」 on the bar);
//                       最近对话 10 rows + 「查看更多（N）」 in v2's fonts; title
//                       28px / 600 / -0.01em; the bar says 「首页」; the composer
//                       sits at the bottom; with no chat the title block's
//                       centre is at 30-50% of the area above the composer
//   composerStable      the composer card (x, y, width, height) and its target
//                       row are where the other page has them, +-1px: the home
//                       page vs the conversation its first message starts
//                       (现状: reported only; dsh.8's start screen uses the
//                       'empty' geometry, so its card moves)
//   menuOpen            (v3, a work-bar menu drawn open) above its trigger,
//                       inside the window, with its groups and footer
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'sidebar-regions-shoot-2026-10'));

const here = __dirname;
const outDir = path.join(here, 'shots');
const measurementsPath = path.join(here, 'measurements.json');

// v1's parameters: the two-segment top region, the busy scene with 「拉取远端更新」
// open, no home entry, addition order, base-800 titles, no fade, a 320px center.
const V1 = { top: 'v1', scene: 'busy', center: 'chat', open: 's1', entry: 'none', order: 'original', ink: 'soft', fade: '0', full: '0', home: 'v2' };
const v1 = (q) => ({ ...V1, ...q });
// v2's home page (two buttons + 最近对话) and its center-column stand-ins.
const v2 = (q) => ({ home: 'v2', ...q });
// v3's home page (title + 10 recent chats + the real composer at dsh.8's one-line
// height); v4 and the 3-line composer (v4.1) are the defaults from 2026-10-10.
const v3 = (q) => ({ home: 'v3', composer: 'current', ...q });

const SHOTS = [
  { file: '01-current-280x900-light.png', q: v1({ mode: 'current' }) },
  { file: '02-proposal-280x900-light.png', q: v1({ mode: 'proposal' }) },
  { file: '03-compare-280x900-light.png', q: v1({ mode: 'compare' }) },
  { file: '04-proposal-280x900-dark.png', q: v1({ mode: 'proposal', theme: 'dark' }) },
  { file: '05-proposal-280x720-light.png', q: v1({ mode: 'proposal', h: '720', bars: '1' }) },
  { file: '06-proposal-280x1080-light.png', q: v1({ mode: 'proposal', h: '1080' }) },
  { file: '07-proposal-280x900-repos-mid.png', q: v1({ mode: 'proposal', scroll: 'mid', bars: '1' }) },
  { file: '08-compare-280x900-repos-mid.png', q: v1({ mode: 'compare', scroll: 'mid', bars: '1' }) },
  {
    file: '09-proposal-280x900-recent-both-more.png',
    q: v1({ mode: 'proposal', active: 'all', lower: 'all', bars: '1' }),
  },
  {
    file: '10-proposal-280x900-recent-scrolled-bottom.png',
    q: v1({ mode: 'proposal', rscroll: 'bottom', bars: '1' }),
  },
  { file: '11-proposal-280x900-recent-collapsed.png', q: v1({ mode: 'proposal', recent: 'collapsed' }) },
  { file: '12-proposal-280x900-collapse-all.png', q: v1({ mode: 'proposal', folders: 'collapsed' }) },
  { file: '13-proposal-360x900-light.png', q: v1({ mode: 'proposal', w: '360' }) },
  { file: '14-proposal-500x900-light.png', q: v1({ mode: 'proposal', w: '500' }) },
  { file: '15-compare-280x900-cjk-win.png', q: v1({ mode: 'compare', cjk: '1' }) },
  { file: '16-proposal-280x900-ink-fg.png', q: v1({ mode: 'proposal', ink: 'fg' }) },
  { file: '17-proposal-280x900-ink-850.png', q: v1({ mode: 'proposal', ink: 'soft850' }) },
  { file: '18-proposal-280x900-guides.png', q: v1({ mode: 'proposal', guides: '1' }) },
  { file: '19-compare-280x900-dark.png', q: v1({ mode: 'compare', theme: 'dark' }) },
  { file: '20-proposal-280x1080-recent-collapsed.png', q: v1({ mode: 'proposal', h: '1080', recent: 'collapsed' }) },
  // v2 (2026-10-10). Defaults: top=v2, scene=startup, center=home, entry=rail,
  // order=activity, ink=mix (derived), fade on, full window.
  { file: '21-v2-1440x900-startup-home.png', q: v2({ mode: 'proposal' }) },
  { file: '22-v2-1440x900-busy-home.png', q: v2({ mode: 'proposal', scene: 'busy' }) },
  { file: '23-v2-1440x900-busy-chat-entry-a.png', q: v2({ mode: 'proposal', scene: 'busy', center: 'chat' }) },
  { file: '24-v2-1440x900-startup-home-dark.png', q: v2({ mode: 'proposal', theme: 'dark' }) },
  { file: '25-v2-1280x720-busy-home.png', q: v2({ mode: 'proposal', scene: 'busy', h: '720', bars: '1' }) },
  {
    file: '26-v2-1440x900-busy-chat-entry-b.png',
    q: v2({ mode: 'proposal', scene: 'busy', center: 'chat', entry: 'toolbar' }),
  },
  {
    file: '27-v2-280x1080-repos-order-top.png',
    q: v2({ mode: 'proposal', h: '1080', folders: 'collapsed', ann: '1' }),
  },
  {
    file: '28-v2-280x1080-repos-order-bottom.png',
    q: v2({ mode: 'proposal', h: '1080', folders: 'collapsed', ann: '1', scroll: 'bottom' }),
  },
  { file: '29-v2-1440x900-home-more.png', q: v2({ mode: 'proposal', homemore: 'all' }) },
  { file: '30-current-1440x900-startup.png', q: v2({ mode: 'current', recent: 'collapsed' }) },
  { file: '31-compare-280x900-busy-v2.png', q: v2({ mode: 'compare', scene: 'busy', center: 'chat' }) },
  // v3 (2026-10-10): only the home page changes. Defaults: home=v3, target=auto
  // (the most recently active repository), menu=none, startup scene.
  { file: '32-v3-1440x900-home.png', q: v3({ mode: 'proposal' }) },
  { file: '33-v3-1440x900-home-target-atlas.png', q: v3({ mode: 'proposal', target: 'atlas' }) },
  { file: '34-v3-1440x900-repo-menu.png', q: v3({ mode: 'proposal', menu: 'repo' }) },
  { file: '35-v3-1440x900-branch-menu.png', q: v3({ mode: 'proposal', menu: 'branch' }) },
  { file: '36-v3-1440x900-newuser.png', q: v3({ mode: 'proposal', scene: 'newuser' }) },
  { file: '37-v3-1440x900-norepo.png', q: v3({ mode: 'proposal', scene: 'norepo' }) },
  { file: '38-v3-1440x900-home-dark.png', q: v3({ mode: 'proposal', theme: 'dark' }) },
  { file: '39-v3-1280x720-home.png', q: v3({ mode: 'proposal', h: '720', bars: '1' }) },
  { file: '40-v3-1440x900-after-send.png', q: v3({ mode: 'proposal', sent: '1', center: 'chat' }) },
  { file: '41-v3-composer-home-vs-sent.png', composite: ['32-v3-1440x900-home.png', '40-v3-1440x900-after-send.png'] },
  { file: '42-current-1440x900-startup-real-composer.png', q: v3({ mode: 'current', recent: 'collapsed' }) },
  { file: '43-v3-1440x900-norepo-repo-menu.png', q: v3({ mode: 'proposal', scene: 'norepo', menu: 'repo' }) },
  { file: '44-v3-1440x900-busy-home.png', q: v3({ mode: 'proposal', scene: 'busy' }) },
  { file: '45-v3-1440x900-home-unbound.png', q: v3({ mode: 'proposal', target: 'unbound' }) },
];

// Every one of these must pass on a 方案 root.
const HARD = [
  'shellChrome',
  'levelFonts',
  'titleInk',
  'regions',
  'regionsIndependent',
  'l1OutsideScroll',
  'recentSegments',
  'activeRegion',
  'noLowerSegment',
  'folderOrder',
  'coordsKept',
  'titleWidth160',
  'noRowOverflow',
  'noSmallCjk',
  'sameDepthX',
  'carriers',
  'reposHeaderButtons',
  'collapseAll',
  'home',
  'homeEntry',
  'homeV3',
  'composerStable',
  'menuOpen',
];
// A 现状 root must pass these to still be dsh.8; the other three
// (regions, regionsIndependent, l1OutsideScroll) are what issue #6 is about
// and fail there by design — reported, not enforced.
const FIDELITY = [
  'shellChrome',
  'levelFonts',
  'titleInk',
  'recentSegments',
  'folderOrder',
  'coordsKept',
  'titleWidth160',
  'noRowOverflow',
  'noSmallCjk',
  'sameDepthX',
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
  while (y < h) {
    const probe = await nextPaint(wc);
    const segH = probe.getSize().height;
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

// The composer strip (bottom 220px of the 1440x900 center column) of two shots,
// stacked, with dashed guides on the FIRST shot's composer card edges, so a
// card that moved after the first send would sit off the guides in the second.
const STRIP = { x: 44 + 280, y: 900 - 220, width: 1440 - 44 - 280, height: 220 };
async function composite(win, shot, measuredByFile) {
  const cardOf = (file) => {
    const m = measuredByFile.get(file);
    const root = m && m.roots.find((r) => r.mode === 'proposal');
    return root && root.checks.composerStable ? root.checks.composerStable.card : null;
  };
  const [aFile, bFile] = shot.composite;
  const a = cardOf(aFile);
  const b = cardOf(bFile);
  if (!a || !b) throw new Error(`composite ${shot.file}: shoot ${aFile} and ${bFile} first`);
  const crop = (file) => nativeImage.createFromPath(path.join(outDir, file)).crop(STRIP).toDataURL();
  const guides = (c) =>
    [
      `<div class="g h" style="top:${c.y - STRIP.y}px"></div>`,
      `<div class="g h" style="top:${c.y + c.h - STRIP.y}px"></div>`,
      `<div class="g v" style="left:${c.x - STRIP.x}px"></div>`,
      `<div class="g v" style="left:${c.x + c.w - STRIP.x}px"></div>`,
    ].join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;background:#fffcf0;color:#100f0f;font:14px/20px "Noto Sans CJK SC","Microsoft YaHei UI",sans-serif}
#c{display:inline-block;padding:12px 16px 16px}
.cap{font-weight:600;margin:0 0 6px}.cap small{margin-left:8px;font-weight:400;font-size:14px;color:#6f6e69}
.s{position:relative;width:${STRIP.width}px;height:${STRIP.height}px;outline:1px solid #cecdc3}
.s img{display:block}.g{position:absolute;pointer-events:none}
.h{left:0;right:0;height:0;border-top:1px dashed rgb(220 0 160 / .85)}
.v{top:0;bottom:0;width:0;border-left:1px dashed rgb(220 0 160 / .85)}
</style><div id="c">
<div class="cap">首页（发送前）<small>${aFile}</small></div><div class="s"><img src="${crop(aFile)}">${guides(a)}</div>
<div class="cap" style="margin-top:14px">发送第一条消息之后的对话页<small>${bFile} · 虚线 = 首页输入框卡片的四条边</small></div><div class="s"><img src="${crop(bFile)}">${guides(a)}</div>
</div></html>`;
  const file = path.join(os.tmpdir(), 'sidebar-regions-composite.html');
  fs.writeFileSync(file, html);
  await win.loadFile(file);
  const size = await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300))).then(() => { const r = document.getElementById("c").getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; })'
  );
  win.setContentSize(size.w, size.h);
  await sleep(400);
  const image = await nextPaint(win.webContents);
  fs.writeFileSync(path.join(outDir, shot.file), image.toPNG());
  fs.rmSync(file, { force: true });
  const delta = { x: b.x - a.x, y: b.y - a.y, w: b.w - a.w, h: b.h - a.h };
  return { file: shot.file, composite: shot.composite, strip: STRIP, image: image.getSize(), card: { [aFile]: a, [bFile]: b }, delta };
}

function failed(root, list) {
  return list.filter((k) => {
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
    height: 1140,
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
  const measuredByFile = new Map();
  if (fs.existsSync(measurementsPath)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(measurementsPath, 'utf8'))) measuredByFile.set(r.file, r);
    } catch {
      // start over
    }
  }
  try {
    for (const shot of ACTIVE) {
      if (shot.composite) {
        const r = await composite(win, shot, measuredByFile);
        results.push(r);
        measuredByFile.set(r.file, r);
        const moved = Object.values(r.delta).some((v) => Math.abs(v) > 1);
        if (moved) failures += 1;
        console.log(`${shot.file} ${JSON.stringify(r.image)} composite card delta ${JSON.stringify(r.delta)} ${moved ? 'MOVED' : 'ok'}`);
        continue;
      }
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
        console.log(`  window clamped to ${got.width}x${got.height}, stitching ${size.w}x${size.h}`);
        image = await stitch(win.webContents, size.w, size.h);
      }
      fs.writeFileSync(path.join(outDir, shot.file), image.toPNG());
      const entry = { file: shot.file, query: shot.q, image: image.getSize(), ...measured };
      results.push(entry);
      measuredByFile.set(shot.file, entry);
      const flags = measured.roots
        .map((r) => {
          if (r.mode === 'proposal') {
            const bad = failed(r, HARD);
            if (bad.length) failures += 1;
            return `proposal:${bad.length ? `FAIL(${bad.join(',')})` : 'ok'}`;
          }
          const bad = failed(r, FIDELITY);
          if (bad.length) failures += 1;
          const goals = ['regions', 'regionsIndependent', 'l1OutsideScroll'].filter((k) => !r.checks[k].pass);
          return `current:${bad.length ? `DRIFT(${bad.join(',')})` : 'faithful'}[issue-goals failing: ${goals.join(',') || 'none'}]`;
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
      console.error(`${failures} root(s) failing (方案 hard criteria or 现状 fidelity)`);
      process.exitCode = 1;
    } else {
      console.log('all 方案 roots pass every hard criterion; every 现状 root matches dsh.8');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
