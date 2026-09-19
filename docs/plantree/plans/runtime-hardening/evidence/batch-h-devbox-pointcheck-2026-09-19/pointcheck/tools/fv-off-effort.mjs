#!/usr/bin/env node
/**
 * fv-off-effort.mjs — the platform's `off` thinking level, end to end.
 *
 * 2026-09-19 morning: the level was ticked upstream but the catalog the app
 * pulled still had `thinkingLevelMap.off: null`, so the selector correctly
 * hid the level (`effortsForModel` drops a level a model maps to null) and the
 * check was recorded as "not delivered yet, UI has no bug". The remote catalog
 * has since moved, so this walks the whole chain once:
 *
 *   forced sync → the file on disk → the level in the menu → a turn run on it.
 *
 * The sync goes through `electronAPI.piModels.sync()`, which is the settings
 * page's own Refresh button (`ipc/piModels.ts` passes `force: true`), not a
 * direct call to the gateway: the point is what the APP fetches and writes.
 * No credential is read, logged or echoed anywhere in this file.
 */
import fs from 'node:fs';
import { Cdp, DEBUG_PORT, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { CLICK_SEND, SEND_READY, makeEval, shoot, typeIntoComposer, writeJson } from './pc-lib.mjs';

const OUT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/fix-verify';
const CATALOG = '/home/ai/.pilab/jyw-ai-client-dev/pi-agent/managed-models-source.json';
const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];
/** Short, cheap, and worded unlike anything else this batch has sent. */
const PROMPT =
  process.env.PC_PROMPT_OFF ?? '一句话回答，不要展开：为什么 0.1 + 0.2 在浮点数里不等于 0.3？';

/** Catalog facts only — never the credentials block that sits next to it. */
function readCatalog() {
  const raw = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const models = {};
  for (const [providerId, provider] of Object.entries(raw.providers ?? {})) {
    for (const model of provider.models ?? []) {
      models[`${providerId}/${model.id}`] = {
        reasoning: model.reasoning ?? null,
        thinkingLevelMap: model.thinkingLevelMap ?? null,
        off: model.thinkingLevelMap ? (model.thinkingLevelMap.off ?? undefined) : undefined,
      };
    }
  }
  return { updatedAt: raw.updatedAt ?? null, version: raw.version ?? null, models };
}

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'fvoff');
const now = () => Date.now();

const out = { probe: 'fv-off-effort.mjs', startedAt: new Date().toISOString() };
const persist = () => writeJson(OUT, 'fv-off-effort.json', out);

const TRIGGER = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => /模型与思考强度|Model and reasoning effort/.test(n.getAttribute('aria-label') ?? ''));
  if (!b) return null;
  return { ariaLabel: b.getAttribute('aria-label'), text: (b.innerText || '').trim().replace(/\\s+/g, ' ') };
})()`;

const OPEN_TRIGGER = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => /模型与思考强度|Model and reasoning effort/.test(n.getAttribute('aria-label') ?? ''));
  if (!b) throw new Error('no model/effort trigger');
  b.click();
  return true;
})()`;

/** Every radio row the open menu paints, with its wire value. */
const MENU_ITEMS = `(() => {
  const items = [...document.querySelectorAll('[role="menuitemradio"]')]
    .filter((n) => n.offsetParent !== null)
    .map((n) => ({
      text: (n.innerText || '').trim().replace(/\\s+/g, ' '),
      value: n.getAttribute('data-value') ?? n.getAttribute('value') ?? null,
      checked: n.getAttribute('aria-checked'),
    }));
  const popup = document.querySelector('[data-slot="menu-popup"], [role="menu"]');
  return {
    count: items.length,
    items,
    popupText: popup ? (popup.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 600) : null,
  };
})()`;

const statusOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  return chat.useChatSessionsStore.getState().sessions.find((x) => x.id === ${JSON.stringify(sid)})?.status ?? null;
`;

async function driveTurn(sid, timeoutMs = 420_000) {
  const t0 = now();
  const busy = new Set(BUSY);
  let sawBusy = false;
  let idleStreak = 0;
  const trail = [];
  while (now() - t0 < timeoutMs) {
    const status = await evalAsync(statusOf(sid), { label: 'status poll' });
    if (trail[trail.length - 1]?.status !== status) trail.push({ status, atMs: now() - t0 });
    if (busy.has(status ?? 'idle')) {
      sawBusy = true;
      idleStreak = 0;
    } else if (sawBusy) {
      idleStreak += 1;
      if (idleStreak >= 3) return { ok: true, totalMs: now() - t0, trail };
    } else if (now() - t0 > 120_000) {
      return { ok: false, reason: 'never went busy', trail };
    }
    await sleep(1200);
  }
  return { ok: false, reason: 'timeout', trail };
}

try {
  out.catalogBefore = readCatalog();
  console.log('catalog before:', out.catalogBefore.updatedAt);
  persist();

  out.sync = await evalAsync(
    `const r = await window.electronAPI.piModels.sync();
     return JSON.parse(JSON.stringify(r));`,
    { timeoutMs: 180_000, label: 'forced catalog sync' }
  );
  console.log('sync:', JSON.stringify(out.sync).slice(0, 400));
  await sleep(2000);
  out.catalogAfter = readCatalog();
  out.catalogMoved = out.catalogAfter.updatedAt !== out.catalogBefore.updatedAt;
  console.log(
    `catalog after: ${out.catalogAfter.updatedAt} (moved=${out.catalogMoved}); opus-5 off=${JSON.stringify(out.catalogAfter.models['claude/claude-opus-5']?.off)}`
  );
  persist();

  // --- the menu ------------------------------------------------------------
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
    { label: 'off-round session id' }
  );
  out.triggerBefore = await cdp.evaluate(TRIGGER);
  await cdp.evaluate(OPEN_TRIGGER);
  // Opening the menu triggers a non-forced catalog refresh; give it a beat so
  // the list is the post-sync one rather than the one React had cached.
  await sleep(3000);
  out.menu = await cdp.evaluate(MENU_ITEMS);
  out.menuShot = await shoot(cdp, OUT, 'fix-off-effort-menu.png');
  console.log('menu items:', JSON.stringify(out.menu.items));
  persist();

  out.offItem =
    out.menu.items.find((i) => i.text === '关闭' || i.text === 'Off' || i.value === 'off') ?? null;
  if (out.offItem) {
    out.offPicked = await cdp.evaluate(`(() => {
      const n = [...document.querySelectorAll('[role="menuitemradio"]')]
        .filter((x) => x.offsetParent !== null)
        .find((x) => {
          const t = (x.innerText || '').trim();
          return t === '关闭' || t === 'Off' || x.getAttribute('data-value') === 'off';
        });
      if (!n) throw new Error('off row vanished');
      n.click();
      return (n.innerText || '').trim();
    })()`);
    await sleep(2000);
  } else {
    await cdp.evaluate(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await sleep(800);
  }
  out.triggerAfter = await cdp.evaluate(TRIGGER);
  out.effortStored = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const sid = ${JSON.stringify(out.sessionId)};
     const session = s.sessions.find((x) => x.id === sid) ?? null;
     return session ? { effort: session.effort ?? null, model: session.model ?? null } : null;`,
    { label: 'stored effort' }
  ).catch((error) => ({ error: String(error?.message ?? error) }));
  console.log('trigger after pick:', JSON.stringify(out.triggerAfter));
  persist();

  // --- one short turn on the new level -------------------------------------
  if (out.offItem) {
    out.prompt = PROMPT;
    await cdp.evaluate(typeIntoComposer(PROMPT));
    await cdp.waitFor(SEND_READY, { timeoutMs: 60_000, label: 'send ready' });
    const t0 = now();
    await cdp.evaluate(CLICK_SEND);
    out.turn = await driveTurn(out.sessionId);
    out.turn.totalMs = now() - t0;
    await sleep(2500);
    out.usage = await evalAsync(
      `const m = await import(/* @vite-ignore */ '/stores/sessionRuntimeFacts.ts');
       const f = m.useSessionRuntimeFactsStore.getState().factsBySession[${JSON.stringify(out.sessionId)}] ?? null;
       const u = f?.usage ?? null;
       return {
         keys: u ? Object.keys(u).sort() : null,
         hasReasoning: u ? Object.hasOwn(u, 'reasoning') : false,
         reasoning: u ? (u.reasoning ?? null) : null,
         context: u && u.context ? JSON.parse(JSON.stringify(u.context)) : null,
       };`,
      { label: 'usage after off turn' }
    );
    out.blocks = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const msgs = s.messages[${JSON.stringify(out.sessionId)}] ?? [];
       const counts = {};
       for (const m of msgs) for (const b of m.blocks ?? []) counts[b.type] = (counts[b.type] ?? 0) + 1;
       let reply = '';
       for (let i = msgs.length - 1; i >= 0; i -= 1) {
         if (msgs[i].role !== 'assistant') continue;
         reply = (msgs[i].blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').trim().slice(0, 500);
         break;
       }
       return { messageCount: msgs.length, blockTypeCounts: counts, reply };`,
      { label: 'blocks after off turn' }
    );
    out.turnLine = await cdp.evaluate(`(() => {
      const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
      let best = '';
      for (const v of viewports) { const t = v.innerText || ''; if (t.length > best.length) best = t; }
      const lines = best.split('\\n').map((l) => l.trim()).filter(Boolean);
      return {
        thinkingLines: lines.filter((l) => /思考|Thinking/.test(l)),
        headLines: lines.filter((l) => /耗时|Worked for|steps processed|tokens/.test(l)),
        tail: lines.slice(-14),
      };
    })()`);
    out.turnShot = await shoot(cdp, OUT, 'fix-off-turn.png');
    console.log('turn:', JSON.stringify(out.turn).slice(0, 200));
    console.log('usage:', JSON.stringify(out.usage));
    console.log('thinking lines:', JSON.stringify(out.turnLine.thinkingLines));
    console.log('block types:', JSON.stringify(out.blocks.blockTypeCounts));
  }

  out.verdict = {
    catalogUpdatedAt: out.catalogAfter?.updatedAt ?? null,
    offValues: Object.fromEntries(
      ['claude/claude-opus-5', 'claude/claude-sonnet-5', 'claude/claude-opus-4-6'].map((k) => [
        k,
        out.catalogAfter?.models?.[k]?.off ?? null,
      ])
    ),
    offOfferedInMenu: Boolean(out.offItem),
    offMenuLabel: out.offItem?.text ?? null,
    triggerAfterPick: out.triggerAfter?.text ?? null,
    thinkingClausesOnTurn: out.turnLine?.thinkingLines ?? null,
    thinkingBlocks: out.blocks?.blockTypeCounts?.thinking ?? 0,
    usageReasoning: out.usage?.reasoning ?? null,
    usageHasReasoningKey: out.usage?.hasReasoning ?? null,
  };
  console.log('\n' + JSON.stringify(out.verdict, null, 1));
} catch (error) {
  out.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', out.error);
  process.exitCode = 1;
} finally {
  try {
    out.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  out.finishedAt = new Date().toISOString();
  console.log(`report → ${persist()}`);
  cdp.close();
}
