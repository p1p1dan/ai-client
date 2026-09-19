/**
 * B — where does a new chat's row land, and under exactly which conditions is
 * it NOT on screen.
 */
import { connect, SIDEBAR, STORE, save, shot, sleep, stamp } from './lib.mjs';

const { cdp, evalAsync } = await connect();

const sidebar = () => cdp.evaluate(SIDEBAR);
const summarise = (sb) => {
  const out = [];
  let group = '(before any header)';
  for (const it of sb.items) {
    if (it.kind === 'groupHeader') group = it.text;
    else if (it.kind === 'row')
      out.push({ group, title: it.title, visible: it.visible, active: it.active });
    else if (it.kind === 'showMore') out.push({ group, showMore: it.text, visible: it.visible });
  }
  return out;
};
const report = (label, sb) => {
  const rows = summarise(sb);
  const byGroup = {};
  for (const r of rows) {
    const k = r.group;
    byGroup[k] = byGroup[k] ?? { total: 0, newChat: 0, showMore: null };
    if (r.showMore) byGroup[k].showMore = r.showMore;
    else {
      byGroup[k].total += 1;
      if (r.title === 'New chat') byGroup[k].newChat += 1;
    }
  }
  console.log(`  ${label}: ${JSON.stringify(byGroup)}`);
  const first = rows
    .filter((r) => !r.showMore)
    .slice(0, 3)
    .map((r) => `${r.group}/${r.title}`);
  console.log(`    first rows: ${JSON.stringify(first)}`);
  return { byGroup, rows: rows.slice(0, 12) };
};

const activateOld = async (title) => {
  const r = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    if (rows.length === 0) return { ok: false, matches: 0 };
    rows[0].click();
    return { ok: true, matches: rows.length };
  })()`);
  await sleep(2500);
  return r;
};
const clickNew = () =>
  cdp.evaluate(`(() => {
    const store = window.__t091_store;
    const pre = store.getState();
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    const post = store.getState();
    return { t: new Date().toISOString(), preCount: pre.sessions.length, postCount: post.sessions.length,
             created: post.activeSessionId !== pre.activeSessionId, newId: post.activeSessionId };
  })()`);

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  const results = {};

  // ---- Phase 1: the Recent group as the app leaves it ----------------------
  console.log(`[${stamp()}] P1 Recent as-found`);
  let sb = await sidebar();
  const recentToggle = sb.items.find((i) => i.kind === 'toggle');
  console.log(
    `  Recent toggle aria-label = ${JSON.stringify(recentToggle?.ariaLabel)} (展开最近 = currently COLLAPSED)`
  );
  results.p1_asFound = { toggle: recentToggle, ...report('as-found', sb) };

  // ---- Phase 2: expand Recent, look again ---------------------------------
  console.log(`[${stamp()}] P2 expand Recent`);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === '展开最近' && n.offsetParent !== null);
    if (!b) return 'already expanded';
    b.click(); return 'clicked';
  })()`);
  await sleep(900);
  sb = await sidebar();
  results.p2_recentExpanded = report('recent expanded', sb);
  console.log('  shot:', await shot(cdp, 'b2-recent-expanded.png'));

  // ---- Phase 3: New from a non-fresh session, with Recent expanded ---------
  console.log(`[${stamp()}] P3 New (Recent expanded)`);
  console.log('  activate old:', JSON.stringify(await activateOld('点验重命名-0919')));
  const c3 = await clickNew();
  console.log('  clickNew:', JSON.stringify(c3));
  const p3 = {};
  for (const ms of [0, 200, 1000, 3000]) {
    if (ms) await sleep(ms === 200 ? 200 : ms === 1000 ? 800 : 2000);
    p3[`plus${ms}`] = report(`+${ms}ms`, await sidebar());
  }
  results.p3_newWithRecentExpanded = { click: c3, snapshots: p3 };
  console.log('  shot:', await shot(cdp, 'b2-new-recent-expanded.png'));

  // ---- Phase 4: rail switch 聊天 → 文件 → 聊天 -----------------------------
  console.log(`[${stamp()}] P4 rail switch`);
  for (const label of ['文件', '聊天']) {
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('nav[aria-label="主导航"] button[aria-label]')]
        .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!b) throw new Error('no rail button ' + ${JSON.stringify(label)});
      b.click(); return true;
    })()`);
    await sleep(1800);
  }
  sb = await sidebar();
  results.p4_afterRailSwitch = report('after rail 聊天→文件→聊天', sb);
  console.log('  shot:', await shot(cdp, 'b2-after-rail-switch.png'));

  // ---- Phase 5: New while a search query is active -------------------------
  console.log(`[${stamp()}] P5 New with an active search query`);
  const typedQuery = await cdp.evaluate(`(() => {
    const open = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === '筛选会话' && n.offsetParent !== null);
    let input = document.querySelector('input[placeholder="搜索会话"]');
    if (!input && open) { open.click(); }
    input = document.querySelector('input[placeholder="搜索会话"]');
    if (!input) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '点验');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: input.value };
  })()`);
  console.log('  query typed:', JSON.stringify(typedQuery));
  await sleep(900);
  results.p5_withQueryBefore = report('query active, before New', await sidebar());
  console.log('  activate old:', JSON.stringify(await activateOld('点验重命名-0919')));
  const c5 = await clickNew();
  console.log('  clickNew:', JSON.stringify(c5));
  await sleep(1200);
  results.p5_withQueryAfter = { click: c5, ...report('query active, after New', await sidebar()) };
  console.log('  shot:', await shot(cdp, 'b2-new-with-search-query.png'));
  // clear the query
  await cdp.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="搜索会话"]');
    if (!input) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'cleared';
  })()`);
  await sleep(900);
  results.p5_afterClearingQuery = report('query cleared', await sidebar());
  console.log('  shot:', await shot(cdp, 'b2-after-clearing-query.png'));

  // ---- Phase 6: New while the project folder is collapsed ------------------
  console.log(`[${stamp()}] P6 New with the ai-client folder collapsed`);
  const collapsed = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button,[role="button"]')]
      .find((n) => (n.innerText || '').trim().startsWith('ai-client') && n.offsetParent !== null && !n.hasAttribute('title'));
    if (!b) return { ok: false, candidates: [...document.querySelectorAll('button')].map((n) => (n.innerText||'').trim()).filter(Boolean).slice(0, 25) };
    b.click();
    return { ok: true };
  })()`);
  console.log('  folder header click:', JSON.stringify(collapsed).slice(0, 400));
  await sleep(1200);
  results.p6_folderCollapsed = report('folder collapsed', await sidebar());
  console.log(
    '  activate old (may fail while collapsed):',
    JSON.stringify(await activateOld('点验重命名-0919'))
  );
  const c6 = await clickNew();
  console.log('  clickNew:', JSON.stringify(c6));
  await sleep(1500);
  results.p6_afterNew = { click: c6, ...report('folder collapsed, after New', await sidebar()) };
  console.log('  shot:', await shot(cdp, 'b2-new-folder-collapsed.png'));

  save('b2-results.json', results);
  save('b2-final-store.json', await evalAsync(STORE, { label: 'store' }));
  save('b2-final-sidebar.json', await sidebar());
} finally {
  cdp.close();
}
