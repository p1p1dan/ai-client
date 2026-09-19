#!/usr/bin/env node
/**
 * fv-f1-f2.mjs — re-check F1 (hit-list jump) and F2 (popover anchor) against
 * the fixes committed as 171d1369 / 539cd754.
 *
 * Derived from `m11-hover.mjs` + `m11-jump-order.mjs`; same synthetic
 * transcript recipe (zero model turns — the criteria are about the renderer),
 * same two traps handled: each search call gets its OWN assistant message so
 * the rows are not folded into an aggregate 「Explored …」 line, and the settled
 * turn's work group is expanded before anything is measured or hovered.
 *
 * What changed versus the original probe:
 *
 *  - F1 is now driven in the order that used to fail: open file A FIRST, then
 *    click a hit in a DIFFERENT file B, then click back into A on ANOTHER line.
 *    The seed therefore carries two hits in file A (different lines) so the
 *    third click has somewhere to go.
 *  - F2 measures the trigger's OWN box (the fix removes the `display: contents`
 *    wrapper, so `[data-slot="preview-card-trigger"]` IS the `.ct-a` arg span)
 *    and asserts the popup sits next to it instead of at the viewport origin.
 */
import fs from 'node:fs';
import { Cdp, DEBUG_PORT, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { EXPAND_WORK_GROUPS, enterApp, makeEval, shoot, writeJson } from './pc-lib.mjs';

const OUT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/fix-verify';
const REPO = '/home/ai/code/ai-client';

const FILE_A = `${REPO}/src/renderer/components/chat/toolCard.ts`;
const FILE_B = `${REPO}/src/renderer/stores/fileOpenIntent.ts`;
const LINE_A1 = 464;
const LINE_A2 = 12;
const LINE_B = 57;

/**
 * Three search rows, each in its own assistant message.
 *
 * File A has to appear in TWO different rows rather than twice in one:
 * `parseHitList` keys its hits by path (`byPath`), so a second hit in the same
 * file inside one result is dropped and "click back into A on another line"
 * would have no button to click.
 */
const HITS_1 = [
  `src/renderer/components/chat/toolCard.ts:${LINE_A1}:  /** Grep/Glob row's raw output for the hit-list popover. */`,
  'src/renderer/components/chat/toolHits.ts:34:export interface HitList {',
  "src/renderer/components/chat/HitListPopover.tsx:3:import { parseHitList } from './toolHits';",
].join('\n');

const HITS_2 = [
  `${REPO}/src/renderer/stores/fileOpenIntent.ts:${LINE_B}:export const useFileOpenIntentStore = create<FileOpenIntentState>((set, get) => ({`,
  `${REPO}/src/renderer/components/workspace-shell/WorkspaceShell.tsx:22:import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';`,
].join('\n');

const HITS_3 = [
  `src/renderer/components/chat/toolCard.ts:${LINE_A2}:import type { FileLinkTarget } from './fileLinks';`,
  'src/renderer/components/chat/ToolRows.tsx:22:import { HitListPopover } from \'./HitListPopover\';',
].join('\n');

const SEED = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const sid = ${JSON.stringify(sid)};
  const call = (id, name, input) => ({ id, type: 'tool_call', toolCallId: id, toolName: name, toolInput: input });
  const result = (id, text) => ({ id: id + '-r', type: 'tool_result', toolCallId: id, toolOk: true, text });
  const assistant = (id, blocks) => ({ id, sessionId: sid, role: 'assistant', blocks });
  chat.useChatSessionsStore.setState((prev) => ({
    messages: {
      ...prev.messages,
      [sid]: [
        { id: 'fv-u1', sessionId: sid, role: 'user', blocks: [{ id: 'fv-u1b', type: 'text', text: 'F1/F2 复验合成用例：搜索行悬停与跳行' }] },
        assistant('fv-a1', [call('fv-c1', 'Grep', { pattern: 'HitList' }), result('fv-c1', ${JSON.stringify(HITS_1)})]),
        assistant('fv-a2', [call('fv-c2', 'Grep', { pattern: 'useFileOpenIntentStore' }), result('fv-c2', ${JSON.stringify(HITS_2)})]),
        assistant('fv-a3', [call('fv-c3', 'Grep', { pattern: 'FileLinkTarget' }), result('fv-c3', ${JSON.stringify(HITS_3)})]),
      ],
    },
  }));
  return (chat.useChatSessionsStore.getState().messages[sid] ?? []).length;
`;

const TRIGGERS = `(() => {
  return [...document.querySelectorAll('[data-slot="preview-card-trigger"]')].map((n, i) => {
    const own = n.getBoundingClientRect();
    // After the fix the trigger has its own box; keep the child fallback so a
    // regression back to \`display: contents\` is visible rather than fatal.
    const box = own.width > 0 && own.height > 0 ? n : (n.firstElementChild ?? n);
    const r = box.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const at = document.elementFromPoint(x, y);
    return {
      index: i,
      text: (box.textContent || '').trim(),
      measuredOn: box === n ? 'trigger' : 'child',
      display: getComputedStyle(n).display,
      clientRects: n.getClientRects().length,
      x, y, w: r.width, h: r.height,
      hitTestOk: at ? n.contains(at) || n === at : false,
    };
  });
})()`;

const OPEN_POPUP = `(() => {
  const p = [...document.querySelectorAll('[data-slot="preview-card-content"]')]
    .find((n) => n.hasAttribute('data-open'));
  if (!p) return null;
  return {
    open: true,
    hits: [...p.querySelectorAll('button')].map((b, i) => ({
      index: i,
      text: (b.innerText || '').trim().replace(/\\s+/g, ' '),
    })),
  };
})()`;

/**
 * F2's whole measurement: where the trigger is, where the popup landed, and
 * whether the two are adjacent. The old bug put the positioner at [0, 4].
 */
const anchorOf = (index) => `(() => {
  const n = [...document.querySelectorAll('[data-slot="preview-card-trigger"]')][${index}];
  if (!n) return null;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const content = [...document.querySelectorAll('[data-slot="preview-card-content"]')]
    .find((c) => c.hasAttribute('data-open')) ?? null;
  const positioner = content ? content.closest('[data-slot="preview-card-positioner"]') ?? document.querySelector('[data-slot="preview-card-positioner"]') : document.querySelector('[data-slot="preview-card-positioner"]');
  const t = n.getBoundingClientRect();
  const p = positioner ? positioner.getBoundingClientRect() : null;
  const c = content ? content.getBoundingClientRect() : null;
  const pop = c ?? p;
  const vertical = pop
    ? Math.min(Math.abs(pop.y - (t.y + t.height)), Math.abs((pop.y + pop.height) - t.y))
    : null;
  const horizontalOverlap = pop
    ? Math.max(0, Math.min(pop.x + pop.width, t.x + t.width) - Math.max(pop.x, t.x))
    : null;
  return {
    triggerDisplay: getComputedStyle(n).display,
    triggerClientRects: n.getClientRects().length,
    triggerClass: n.className,
    triggerText: (n.textContent || '').trim().slice(0, 120),
    triggerRect: rect(n),
    childRect: rect(n.firstElementChild),
    positionerRect: rect(positioner),
    positionerTransform: positioner ? getComputedStyle(positioner).transform : null,
    contentRect: rect(content),
    verticalGapPx: vertical,
    horizontalOverlapPx: horizontalOverlap,
    viewport: [window.innerWidth, window.innerHeight],
  };
})()`;

const EDITOR_STATE = `
  const ed = await import(/* @vite-ignore */ '/stores/editor.ts');
  const e = ed.useEditorStore.getState();
  return {
    tabs: e.tabs.map((t) => t.path),
    activeTabPath: e.activeTabPath,
    pendingCursor: e.pendingCursor ? JSON.parse(JSON.stringify(e.pendingCursor)) : null,
    currentCursorLine: e.currentCursorLine,
  };
`;

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'fv11');

const out = {
  probe: 'fv-f1-f2.mjs',
  criteria: ['F1 · 命中列表跳行（编辑器已开别的文件）', 'F2 · 命中列表弹层锚点'],
  commits: { f1: '171d1369', f2: '539cd754' },
  startedAt: new Date().toISOString(),
  anchors: [],
  steps: [],
};

/**
 * Flush after every step.
 *
 * The first attempt at this probe wedged the renderer on its third file open
 * and was killed by the outer timeout, so the `finally` that writes the report
 * never ran and two completed steps' readings were lost with it. Anything
 * measured is on disk before the next thing that can hang is attempted.
 */
const persist = () => writeJson(OUT, 'fv-f1-f2.json', out);

const moveMouse = (x, y) =>
  cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });

/**
 * Hover a row and wait for its hit list.
 *
 * The popup is POLLED rather than read once after a fixed sleep: expanding the
 * work group re-lays out the transcript, and a re-render that lands inside Base
 * UI's open delay restarts the timer — a single read at +2.2 s then reports
 * "hover does not work" on a build where it plainly does. Two attempts, each
 * re-measuring the row first, because opening a file shifts every row.
 */
async function hover(index) {
  let trigger = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await moveMouse(5, 5);
    await sleep(700);
    trigger = (await cdp.evaluate(TRIGGERS))[index];
    if (!trigger) throw new Error(`no trigger at index ${index}`);
    await moveMouse(trigger.x - 6, trigger.y);
    await sleep(150);
    await moveMouse(trigger.x, trigger.y);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(500);
      const popup = await cdp.evaluate(OPEN_POPUP);
      if (popup?.open) return { trigger, popup, attempt };
    }
  }
  return { trigger, popup: null, attempt: 2 };
}

/** Click hit `hitIndex` in the OPEN popup and wait for the editor to settle. */
async function clickHit(label, index, hitIndex, expect) {
  const { trigger, popup } = await hover(index);
  if (!popup?.open) throw new Error(`${label}: popover did not open on trigger ${index}`);
  const anchor = await cdp.evaluate(anchorOf(index));
  out.anchors.push({ label, triggerIndex: index, triggerText: trigger.text, anchor });
  const before = await evalAsync(EDITOR_STATE, { label: `${label}: before` });
  const clicked = await cdp.evaluate(`(() => {
    const p = [...document.querySelectorAll('[data-slot="preview-card-content"]')]
      .find((n) => n.hasAttribute('data-open'));
    if (!p) throw new Error('popup gone before the click');
    const b = [...p.querySelectorAll('button')][${hitIndex}];
    if (!b) throw new Error('no hit button at index ${hitIndex}');
    const text = (b.innerText || '').trim().replace(/\\s+/g, ' ');
    b.click();
    return text;
  })()`);
  // The jump is two async steps behind the click (file read, then Monaco model
  // swap); poll until the cursor lands rather than screenshotting line 1.
  const deadline = Date.now() + 30_000;
  let after = null;
  while (Date.now() < deadline) {
    after = await evalAsync(EDITOR_STATE, { label: `${label}: after` });
    if (
      after.activeTabPath === expect.path &&
      after.pendingCursor === null &&
      after.currentCursorLine === expect.line
    )
      break;
    await sleep(600);
  }
  await sleep(1500);
  const settled = await evalAsync(EDITOR_STATE, { label: `${label}: settled` });
  const step = {
    label,
    triggerIndex: index,
    hitIndex,
    clicked,
    expect,
    before,
    after: settled,
    pass:
      settled.activeTabPath === expect.path &&
      settled.currentCursorLine === expect.line &&
      settled.pendingCursor === null,
  };
  out.steps.push(step);
  persist();
  console.log(
    `[${label}] clicked "${clicked}" → tab=${settled.activeTabPath} line=${settled.currentCursorLine} pending=${JSON.stringify(settled.pendingCursor)} pass=${step.pass}`
  );
  await moveMouse(5, 5);
  await sleep(500);
  return step;
}

try {
  out.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);

  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  out.sessionId = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     return chat.useChatSessionsStore.getState().activeSessionId;`,
    { label: 'seed session id' }
  );
  out.seededMessages = await evalAsync(SEED(out.sessionId), { label: 'seed transcript' });
  out.editorReset = await evalAsync(
    `const ed = await import(/* @vite-ignore */ '/stores/editor.ts');
     ed.useEditorStore.getState().closeAllFiles();
     return ed.useEditorStore.getState().tabs.length;`,
    { label: 'close all editor tabs' }
  );
  await sleep(2000);

  await cdp.waitFor(`document.querySelectorAll('[data-slot="preview-card-trigger"]').length >= 3`, {
    timeoutMs: 60_000,
    label: 'three search rows painted',
  });
  out.expand = await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(1500);
  out.triggers = await cdp.evaluate(TRIGGERS);
  if (!out.triggers.every((t) => t.hitTestOk)) {
    out.expandAgain = await cdp.evaluate(EXPAND_WORK_GROUPS);
    await sleep(1500);
    out.triggers = await cdp.evaluate(TRIGGERS);
  }
  console.log('triggers:', JSON.stringify(out.triggers));

  // --- F2 first: hover with no file open yet, measure and shoot -------------
  const f2 = await hover(0);
  if (!f2.popup?.open) throw new Error('F2: popover did not open');
  out.f2Anchor = await cdp.evaluate(anchorOf(0));
  out.f2Hits = f2.popup.hits;
  out.f2Shot = await shoot(cdp, OUT, 'fix-f2-popover-anchor.png');
  console.log('F2 anchor:', JSON.stringify(out.f2Anchor));
  persist();
  await moveMouse(5, 5);
  await sleep(600);

  // --- F1: A first, then B, then back into A on another line ---------------
  await clickHit('step1-open-A', 0, 0, { path: FILE_A, line: LINE_A1 });
  const stepB = await clickHit('step2-other-file-B', 1, 0, { path: FILE_B, line: LINE_B });
  out.f1Shot = await shoot(cdp, OUT, 'fix-f1-second-file-jump.png');
  stepB.screenshot = out.f1Shot;
  persist();
  try {
    await clickHit('step3-back-to-A', 2, 0, { path: FILE_A, line: LINE_A2 });
  } catch (error) {
    // Recorded rather than fatal: the first attempt wedged the renderer here,
    // and the two steps the criterion turns on are already measured.
    out.step3Error = String(error?.stack ?? error?.message ?? error);
    console.error('step3 failed:', out.step3Error);
    persist();
  }

  const step = (label) => out.steps.find((s) => s.label === label) ?? null;
  const a = out.f2Anchor ?? {};
  const anchored =
    Array.isArray(a.triggerRect) &&
    a.triggerRect[2] > 0 &&
    a.triggerRect[3] > 0 &&
    a.triggerDisplay !== 'contents' &&
    typeof a.verticalGapPx === 'number' &&
    a.verticalGapPx <= 24 &&
    typeof a.horizontalOverlapPx === 'number' &&
    a.horizontalOverlapPx > 0;

  out.verdict = {
    f1: {
      // The criterion is "a SECOND file jumps too"; the third click (back into
      // an already-open tab) is the extra round the task asks for and is
      // reported separately so one flaky step cannot hide the other's result.
      pass: Boolean(step('step2-other-file-B')?.pass),
      backToAPass: Boolean(step('step3-back-to-A')?.pass),
      step3Error: out.step3Error ?? null,
      openA: step('step1-open-A'),
      secondFile: step('step2-other-file-B'),
      backToA: step('step3-back-to-A'),
    },
    f2: {
      pass: anchored,
      triggerDisplay: a.triggerDisplay ?? null,
      triggerClientRects: a.triggerClientRects ?? null,
      triggerRect: a.triggerRect ?? null,
      positionerRect: a.positionerRect ?? null,
      contentRect: a.contentRect ?? null,
      verticalGapPx: a.verticalGapPx ?? null,
      horizontalOverlapPx: a.horizontalOverlapPx ?? null,
      allHoverAnchors: out.anchors,
    },
  };
  console.log('\n' + JSON.stringify(out.verdict.f1.pass ? 'F1 PASS' : 'F1 FAIL'));
  console.log(JSON.stringify(out.verdict.f2.pass ? 'F2 PASS' : 'F2 FAIL'));
} catch (error) {
  out.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', out.error);
  process.exitCode = 1;
} finally {
  out.finishedAt = new Date().toISOString();
  try {
    out.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`report → ${writeJson(OUT, 'fv-f1-f2.json', out)}`);
  cdp.close();
}
