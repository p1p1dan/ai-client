/**
 * B3 — precise group attribution (Recent section vs repository folder), and the
 * two conditions that hide a brand-new chat's row.
 */
import { connect, save, shot, sleep, stamp } from './lib.mjs';

const PRECISE = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const recentP = [...document.querySelectorAll('p')].find(
    (p) => /^(最近|Recent)$/.test((p.innerText || '').trim())
  );
  const recentSection = recentP ? recentP.closest('section') : null;
  const rows = [...document.querySelectorAll('[role="button"][title]')].filter(vis);
  const showMore = [...document.querySelectorAll('button')]
    .filter((b) => vis(b) && /^(显示更多|Show more)/.test((b.innerText || '').trim()))
    .map((b) => (b.innerText || '').trim().replace(/\\s+/g, ' '));
  const toggle = [...document.querySelectorAll('button[aria-label]')]
    .filter((b) => /^(展开最近|收起最近)$/.test(b.getAttribute('aria-label')))
    .map((b) => b.getAttribute('aria-label'));
  const classify = (r) => (recentSection && recentSection.contains(r) ? 'recent' : 'folder');
  const grouped = { recent: [], folder: [] };
  for (const r of rows) {
    grouped[classify(r)].push({
      title: r.getAttribute('title'),
      active: /bg-selection/.test(r.className || ''),
    });
  }
  const query = document.querySelector('input[placeholder="搜索会话"]');
  return {
    t: new Date().toISOString(),
    recentToggle: toggle,
    showMore,
    searchQuery: query ? query.value : '(input not mounted)',
    recentCount: grouped.recent.length,
    folderCount: grouped.folder.length,
    recentTop: grouped.recent.slice(0, 5),
    folderTop: grouped.folder.slice(0, 5),
    newChatInRecent: grouped.recent.filter((x) => x.title === 'New chat').length,
    newChatInFolder: grouped.folder.filter((x) => x.title === 'New chat').length,
    folderHeaderTexts: [...document.querySelectorAll('[role="button"],button')]
      .filter((n) => vis(n) && !n.hasAttribute('title') && /^(ai-client|临时对话|Temporary chats)/.test((n.innerText || '').trim()))
      .map((n) => (n.innerText || '').trim().split('\\n')[0]),
  };
})()`;

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  const out = {};
  const snap = async (label) => {
    const p = await cdp.evaluate(PRECISE);
    console.log(
      `  ${label}: recent=${p.recentCount}(newChat ${p.newChatInRecent}) folder=${p.folderCount}(newChat ${p.newChatInFolder}) ` +
        `showMore=${JSON.stringify(p.showMore)} toggle=${JSON.stringify(p.recentToggle)} query=${JSON.stringify(p.searchQuery)}`
    );
    console.log(`     recentTop=${JSON.stringify(p.recentTop.map((x) => x.title))}`);
    console.log(`     folderTop=${JSON.stringify(p.folderTop.map((x) => x.title))}`);
    out[label] = p;
    return p;
  };

  // Restore the folder to expanded (B2 left it collapsed).
  console.log(`[${stamp()}] restore folder expansion`);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button,[role="button"]')]
      .find((n) => (n.innerText || '').trim().startsWith('ai-client') && n.offsetParent !== null && !n.hasAttribute('title'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1200);
  await snap('01-folder-expanded');

  // New chat from a non-fresh session, Recent expanded, no query.
  console.log(`[${stamp()}] New from a non-fresh session`);
  await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === '点验重命名-0919');
    if (rows[0]) rows[0].click();
    return rows.length;
  })()`);
  await sleep(2500);
  await snap('02-old-session-active');
  const click = await cdp.evaluate(`(() => {
    const store = window.__t091_store;
    const pre = store.getState();
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    const post = store.getState();
    return { preCount: pre.sessions.length, postCount: post.sessions.length,
             created: post.activeSessionId !== pre.activeSessionId, newId: post.activeSessionId };
  })()`);
  console.log('  clickNew:', JSON.stringify(click));
  out['03-click'] = click;
  await sleep(300);
  await snap('03-after-new');
  console.log('  shot:', await shot(cdp, 'b3-new-both-groups.png'));

  // Collapse Recent again and see what is left.
  console.log(`[${stamp()}] collapse Recent`);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === '收起最近' && n.offsetParent !== null);
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  await snap('04-recent-collapsed');
  console.log('  shot:', await shot(cdp, 'b3-recent-collapsed.png'));

  save('b3-results.json', out);
} finally {
  cdp.close();
}
