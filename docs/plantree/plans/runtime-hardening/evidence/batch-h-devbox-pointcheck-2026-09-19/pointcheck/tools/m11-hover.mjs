#!/usr/bin/env node
/**
 * m11-hover.mjs — MODEL-11: hover a search row, get a hit list, click a hit,
 * land in the editor on that line.
 *
 * Synthetic transcript, no real turn: the criterion is about the renderer
 * (`HitListPopover` → `parseHitList` → `fileOpenIntent` → `EditorColumn`), and
 * paying a model to run `grep` would only add a way for the test to fail for a
 * reason that is not the test. Seed recipe follows
 * `scripts/run-batch4-language-probe.mjs`'s SEED.
 *
 * Two things the seed has to get right or the row under test never appears:
 *  1. each search call goes in its OWN assistant message. Two adjacent
 *     explore-class runs collapse into one 「Explored N files, M searches」
 *     aggregate row (`deriveToolGroupRows`, >= 2 completed runs), and an
 *     aggregate row carries no `hitSource` — so the popover would be gone for
 *     a reason unrelated to MODEL-11.
 *  2. every hit line is a REAL file and line in this repo, because the whole
 *     point of the click half is that the editor opens the thing. One row uses
 *     repo-relative paths and one uses absolute paths, since which of the two
 *     the resolver accepts is exactly what the criterion leaves open.
 */
import path from 'node:path';
import { Cdp, DEBUG_PORT, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { EXPAND_WORK_GROUPS, enterApp, makeEval, shoot, writeJson } from './pc-lib.mjs';

const ROOT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const OUT11 = path.join(ROOT, 'model-11');
const REPO = '/home/ai/code/ai-client';

const RELATIVE_HITS = [
  "src/renderer/components/chat/toolCard.ts:464:  /** Grep/Glob row's raw output for the hit-list popover; parsing is toolHits.parseHitList's job. */",
  'src/renderer/components/chat/toolHits.ts:34:export interface HitList {',
  "src/renderer/components/chat/HitListPopover.tsx:3:import { parseHitList } from './toolHits';",
  "src/renderer/components/chat/ToolRows.tsx:22:import { HitListPopover } from './HitListPopover';",
].join('\n');

const ABSOLUTE_HITS = [
  `${REPO}/src/renderer/stores/fileOpenIntent.ts:57:export const useFileOpenIntentStore = create<FileOpenIntentState>((set, get) => ({`,
  `${REPO}/src/renderer/components/workspace-shell/SessionReviewPanel.tsx:10:import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';`,
  `${REPO}/src/renderer/components/workspace-shell/WorkspaceShell.tsx:22:import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';`,
].join('\n');

const GLOB_HITS = [
  'scripts/afterPack.mjs',
  'scripts/agent-host-build-lib.mjs',
  'scripts/assert-build-target.mjs',
  'scripts/build-agent-host.mjs',
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
        { id: 'm11-u1', sessionId: sid, role: 'user', blocks: [{ id: 'm11-u1b', type: 'text', text: 'MODEL-11 合成用例：搜索行悬停' }] },
        assistant('m11-a1', [call('m11-c1', 'Grep', { pattern: 'HitList' }), result('m11-c1', ${JSON.stringify(RELATIVE_HITS)})]),
        assistant('m11-a2', [call('m11-c2', 'Grep', { pattern: 'useFileOpenIntentStore' }), result('m11-c2', ${JSON.stringify(ABSOLUTE_HITS)})]),
        assistant('m11-a3', [call('m11-c3', 'Glob', { pattern: 'scripts/*.mjs' }), result('m11-c3', ${JSON.stringify(GLOB_HITS)})]),
      ],
    },
  }));
  return (chat.useChatSessionsStore.getState().messages[sid] ?? []).length;
`;

/**
 * `hitTestOk` is the field that matters, and it is why the first run of this
 * probe reported "hover does not work" when the hover was never delivered: a
 * settled turn folds its tool rows into a COLLAPSED `<details>` work group, and
 * a collapsed group's contents still report a plausible-looking
 * `getBoundingClientRect` while being neither painted nor hit-tested. Real
 * mouse input therefore lands on the scroll viewport behind them. The probe now
 * expands the groups first and asserts that the point it is about to hover
 * actually resolves to the trigger.
 */
const TRIGGERS = `(() => {
  return [...document.querySelectorAll('[data-slot="preview-card-trigger"]')].map((n, i) => {
    // The trigger renders with \`display: contents\` (HitListPopover keeps the
    // arg span as the flex item), so it has no box of its own — measure the
    // child that actually paints.
    const box = n.firstElementChild ?? n;
    const r = box.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const at = document.elementFromPoint(x, y);
    return {
      index: i,
      text: (box.textContent || '').trim(),
      x, y, w: r.width, h: r.height,
      hitTestOk: at ? n.contains(at) || n === at : false,
    };
  });
})()`;

/**
 * Only an OPEN popup counts. Base UI keeps a closed popover mounted and only
 * flips `data-open` → `data-closed` (see the batch's own note on this), so
 * reading `querySelector(...)` without checking the attribute returns the
 * PREVIOUS hover's hit list and makes a failed hover look successful.
 */
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

const ANY_POPUP_STATE = `(() => {
  return [...document.querySelectorAll('[data-slot="preview-card-content"]')].map((n) => ({
    open: n.hasAttribute('data-open'),
    closed: n.hasAttribute('data-closed'),
  }));
})()`;

/**
 * Where the popup actually lands, next to where the row is.
 *
 * Recorded because the screenshots show the hit list in the window's top-left
 * corner rather than under the row: `HitListPopover` gives the Base UI trigger
 * `render={<span className="contents" />}`, and a `display: contents` element
 * has NO box — `getClientRects()` is empty and `getBoundingClientRect()` is all
 * zeroes — so the positioner anchors to the viewport origin.
 */
const ANCHOR = `(() => {
  const n = document.querySelector('[data-slot="preview-card-trigger"]');
  if (!n) return null;
  const own = n.getBoundingClientRect();
  const child = n.firstElementChild ? n.firstElementChild.getBoundingClientRect() : null;
  const positioner = document.querySelector('[data-slot="preview-card-positioner"]');
  const pr = positioner ? positioner.getBoundingClientRect() : null;
  return {
    triggerDisplay: getComputedStyle(n).display,
    triggerRect: [own.x, own.y, own.width, own.height],
    triggerClientRects: n.getClientRects().length,
    childRect: child ? [child.x, child.y, child.width, child.height] : null,
    positionerRect: pr ? [pr.x, pr.y, pr.width, pr.height] : null,
    positionerTransform: positioner ? getComputedStyle(positioner).transform : null,
  };
})()`;

const EDITOR_STATE = `
  const [ed, intent] = await Promise.all([
    import(/* @vite-ignore */ '/stores/editor.ts'),
    import(/* @vite-ignore */ '/stores/fileOpenIntent.ts'),
  ]);
  const e = ed.useEditorStore.getState();
  return {
    tabs: e.tabs.map((t) => ({ path: t.path, title: t.title })),
    activeTabPath: e.activeTabPath,
    pendingCursor: e.pendingCursor ? JSON.parse(JSON.stringify(e.pendingCursor)) : null,
    currentCursorLine: e.currentCursorLine,
    intent: intent.useFileOpenIntentStore.getState().intent,
  };
`;

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'm11');

const out = { probe: 'm11-hover.mjs', criterion: 'MODEL-11', startedAt: new Date().toISOString(), hovers: [], clicks: [] };

async function moveMouse(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
}

/**
 * Two ways in, tried in order; the report says which one actually opened it.
 *
 * Coordinates are re-measured immediately before the move, never reused from an
 * earlier pass: opening a file splits the centre column, which shifts every row
 * in the transcript. The first version of this probe measured once up front and
 * then "failed" to hover rows 2 and 3 — it was pointing at where they used to
 * be.
 */
async function hover(index) {
  await moveMouse(5, 5);
  await sleep(700);
  const trigger = (await cdp.evaluate(TRIGGERS))[index];
  if (!trigger) throw new Error(`no trigger at index ${index}`);
  await moveMouse(trigger.x - 6, trigger.y);
  await sleep(150);
  await moveMouse(trigger.x, trigger.y);
  await sleep(2200);
  let popup = await cdp.evaluate(OPEN_POPUP);
  if (popup?.open) return { method: 'Input.dispatchMouseEvent', popup, trigger };

  const dispatched = await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('[data-slot="preview-card-trigger"]')][${index}];
    if (!n) throw new Error('trigger vanished');
    // pointerenter / mouseenter do not bubble, so they go on the trigger
    // itself (the display:contents span carrying Base UI's props), not only on
    // the child that paints.
    for (const target of [n, n.firstElementChild].filter(Boolean)) {
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
        const Ctor = type.startsWith('pointer') ? window.PointerEvent : window.MouseEvent;
        target.dispatchEvent(new Ctor(type, { bubbles: !type.endsWith('enter'), cancelable: true, pointerType: 'mouse' }));
      }
    }
    return true;
  })()`);
  await sleep(2200);
  popup = await cdp.evaluate(OPEN_POPUP);
  return {
    method: popup?.open ? 'synthetic pointer events' : 'none',
    dispatched,
    popup,
    trigger,
    popupStates: await cdp.evaluate(ANY_POPUP_STATE),
  };
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
  const sid = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     return chat.useChatSessionsStore.getState().activeSessionId;`,
    { label: 'seed session id' }
  );
  out.sessionId = sid;
  out.seededMessages = await evalAsync(SEED(sid), { label: 'seed transcript' });
  // Start from zero tabs so "a file opened" is unambiguous across rounds.
  out.editorReset = await evalAsync(
    `const ed = await import(/* @vite-ignore */ '/stores/editor.ts');
     ed.useEditorStore.getState().closeAllFiles();
     return ed.useEditorStore.getState().tabs.length;`,
    { label: 'close all editor tabs' }
  );
  await sleep(2000);

  await cdp.waitFor(`document.querySelectorAll('[data-slot="preview-card-trigger"]').length >= 3`, {
    timeoutMs: 30_000,
    label: 'three search rows painted',
  });
  // The rows land inside a collapsed work group; open it before measuring.
  out.expand = await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(1500);
  out.triggers = await cdp.evaluate(TRIGGERS);
  if (!out.triggers.every((t) => t.hitTestOk)) {
    out.expandAgain = await cdp.evaluate(EXPAND_WORK_GROUPS);
    await sleep(1500);
    out.triggers = await cdp.evaluate(TRIGGERS);
  }
  console.log('triggers:', JSON.stringify(out.triggers));

  const named = [
    { key: 'grep-relative', file: 'model-11-grep-hover.png', clickIndex: 2 },
    { key: 'grep-absolute', file: 'model-11-grep-abs-hover.png', clickIndex: 0 },
    { key: 'glob', file: 'model-11-glob-hover.png', clickIndex: 0 },
  ];

  for (let i = 0; i < named.length && i < out.triggers.length; i += 1) {
    const spec = named[i];
    const result = await hover(i);
    const trigger = result.trigger;
    const anchor = await cdp.evaluate(ANCHOR);
    const shot = await shoot(cdp, OUT11, spec.file);
    const entry = { ...spec, trigger, method: result.method, popup: result.popup, anchor, screenshot: shot };
    out.hovers.push(entry);
    console.log(`[${spec.key}] method=${result.method} hits=${JSON.stringify(result.popup?.hits ?? null)}`);

    if (result.popup?.open && (result.popup.hits?.length ?? 0) > spec.clickIndex) {
      const before = await evalAsync(EDITOR_STATE, { label: `${spec.key}: editor before` });
      const clicked = await cdp.evaluate(`(() => {
        // The OPEN one. A closed Base UI popup stays in the DOM, so a plain
        // querySelector can hand back the previous row's hit list — which is
        // how an earlier run "opened the absolute path" by clicking a
        // relative-path hit from the round before.
        const p = [...document.querySelectorAll('[data-slot="preview-card-content"]')]
          .find((n) => n.hasAttribute('data-open'));
        if (!p) throw new Error('popup gone before the click');
        const b = [...p.querySelectorAll('button')][${spec.clickIndex}];
        if (!b) throw new Error('no hit button at that index');
        const text = (b.innerText || '').trim().replace(/\\s+/g, ' ');
        b.click();
        return text;
      })()`);
      // Opening a file is an async read and the line jump is a SECOND async
      // step: `navigateToFile` parks a `pendingCursor`, and Monaco clears it
      // only once the model is mounted and the cursor has been placed. Waiting
      // for the tab alone screenshots the file at line 1 and makes a working
      // jump look broken.
      let after = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        after = await evalAsync(EDITOR_STATE, { label: `${spec.key}: editor after` });
        const tabArrived =
          (after.activeTabPath && after.activeTabPath !== before.activeTabPath) ||
          after.tabs.length > before.tabs.length;
        if (tabArrived && after.pendingCursor === null && after.currentCursorLine != null) break;
        await sleep(600);
      }
      await sleep(2000);
      const afterSettled = await evalAsync(EDITOR_STATE, { label: `${spec.key}: editor settled` });
      const jumpShot = await shoot(
        cdp,
        OUT11,
        spec.key === 'grep-relative' ? 'model-11-jump.png' : `model-11-jump-${spec.key}.png`
      );
      out.clicks.push({ key: spec.key, clicked, before, after: afterSettled, screenshot: jumpShot });
      console.log(
        `[${spec.key}] clicked "${clicked}" → tab=${afterSettled.activeTabPath} cursor=${JSON.stringify(afterSettled.pendingCursor)} line=${afterSettled.currentCursorLine}`
      );
    }
    await moveMouse(5, 5);
    await sleep(600);
  }

  const rel = out.clicks.find((c) => c.key === 'grep-relative');
  const abs = out.clicks.find((c) => c.key === 'grep-absolute');
  const glob = out.clicks.find((c) => c.key === 'glob');
  const EXPECT_REL = `${REPO}/src/renderer/components/chat/HitListPopover.tsx`;
  const EXPECT_ABS = `${REPO}/src/renderer/stores/fileOpenIntent.ts`;
  const EXPECT_GLOB = `${REPO}/scripts/afterPack.mjs`;
  out.verdict = {
    hoverOpenedPopover: out.hovers.filter((h) => h.popup?.open).length,
    hoverMethods: out.hovers.map((h) => ({ key: h.key, method: h.method })),
    hitsListed: out.hovers.map((h) => ({ key: h.key, hits: h.popup?.hits?.map((x) => x.text) ?? null })),
    relativeClicked: rel?.clicked ?? null,
    relativeTab: rel?.after?.activeTabPath ?? null,
    relativePathOpened: rel?.after?.activeTabPath === EXPECT_REL,
    relativeCursor: rel?.after?.pendingCursor ?? null,
    relativeCursorLine: rel?.after?.currentCursorLine ?? null,
    absoluteClicked: abs?.clicked ?? null,
    absoluteTab: abs?.after?.activeTabPath ?? null,
    absolutePathOpened: abs?.after?.activeTabPath === EXPECT_ABS,
    absoluteCursor: abs?.after?.pendingCursor ?? null,
    absoluteCursorLine: abs?.after?.currentCursorLine ?? null,
    globClicked: glob?.clicked ?? null,
    globTab: glob?.after?.activeTabPath ?? null,
    globPathOpened: glob?.after?.activeTabPath === EXPECT_GLOB,
    globCursorLine: glob?.after?.currentCursorLine ?? null,
    // Defect, recorded rather than smoothed over: the list is right, the place
    // it is drawn is not.
    popoverAnchoredToRow: out.hovers.every((h) => (h.anchor?.positionerRect?.[1] ?? 0) > 40),
    anchors: out.hovers.map((h) => ({ key: h.key, anchor: h.anchor })),
  };
  console.log('\n' + JSON.stringify(out.verdict, null, 1));
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
  console.log(`report → ${writeJson(OUT11, 'report.json', out)}`);
  cdp.close();
}
