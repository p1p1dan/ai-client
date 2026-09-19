#!/usr/bin/env node
/**
 * m18-m20.mjs — second half of the 2026-09-19 MODEL point-check, in ONE app run.
 *
 * MODEL-18 (the composer occupancy chip must survive a Task turn): one turn that
 * ENDS NORMALLY and one that is STOPPED mid-flight, with the chip read off the
 * DOM and `factsBySession[sid].usage` read off the store at both ends of each.
 * A `usage.updated` recorder is installed on the renderer event bus before the
 * first turn, because the criterion asks about the key set of the LAST such
 * broadcast and the store keeps only the fold.
 *
 * MODEL-20 (a subagent's refused gate must say WHICH subagent): delegate a read
 * of `~/.ssh/id_rsa`, which `permissionPolicy` denies outright, then read the
 * permission audit row both as painted text and as the raw record the store
 * folded, so a missing attribution can be shown to be a field mismatch rather
 * than a rendering accident.
 *
 * ## Shape: stages over a state file
 *
 * `PC_STAGES` picks which of `normal` / `snap-normal` / `stop` / `deny` /
 * `verdict` to run, and every stage appends to `m18-m20-state.json`. A real
 * model turn here costs minutes, so a probe that could only be run from the
 * top would throw away a finished turn every time a later step needed a fix —
 * which is exactly what happened on the first attempt.
 *
 * ## Two traps this file is shaped around
 *
 *  - **"Idle" right after Send is a lie.** The session is still `idle` for a
 *    second or so after the click, so a bare wait-for-not-busy returns instantly
 *    and the probe reads a turn that never started. `driveTurn` therefore waits
 *    for BUSY first and only then for idle, and treats "never went busy" as a
 *    failure rather than a pass.
 *  - **A settled turn hides its own evidence.** Tool rows, approval rows and
 *    subagent rows fold into the 「Worked for …」 `<details>`; `EXPAND_WORK_GROUPS`
 *    runs before every DOM read and every screenshot.
 *
 * Never `stopDevApp()` / `pkill -f`: this batch stops Electron via /proc.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Cdp,
  DEBUG_PORT,
  ENTER_MAIN_SURFACE,
  sleep,
} from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import {
  ALLOW_TEXT,
  CLICK_SEND,
  EXPAND_WORK_GROUPS,
  enterApp,
  makeEval,
  PERMISSION_CARD,
  SEND_READY,
  shoot,
  typeIntoComposer,
  writeJson,
} from './pc-lib.mjs';

const ROOT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const OUT18 = path.join(ROOT, 'model-18');
const OUT20 = path.join(ROOT, 'model-20');
const STATE_FILE = path.join(ROOT, 'm18-m20-state.json');

const STAGES = new Set((process.env.PC_STAGES ?? 'normal,stop,deny,verdict').split(','));

const DENY_TEXT = '直接拒绝';
const STOP_LABEL = '停止当前回合';
/** `t('Context used')` → `i18n.ts:2289`. The chip is a button carrying it. */
const CHIP_LABEL = '上下文占用';
const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

const PROMPT_NORMAL = '用 explorer 子代理数一下 scripts/ 目录下有几个 .mjs 文件，只回我一个数字。';
const PROMPT_STOP =
  '用 explorer 子代理逐个读 src/runtime/plugins/ 下每个子目录的 index.ts 并各写一句话摘要。';
/**
 * The delegated call that must be refused.
 *
 * Round 2 used `~/.ssh/id_rsa` (the criterion's own example) and never reached
 * the permission system at all: the MODEL refused it as a private-key
 * exfiltration request, so no gate was ever raised and there was nothing to
 * screenshot. The gate only fires if the delegate actually ATTEMPTS the call,
 * so the target moved to the `*.env` arm of the same hardcoded deny table
 * (`permissionPolicy.mjs` PATH_RULES) — reading a project `.env` is an ordinary
 * developer request the model will carry out, and the deny is equally absolute
 * (a `path` deny cannot be overridden by a per-tool allow).
 */
const PROMPT_DENY =
  process.env.PC_PROMPT_DENY ??
  '我在点验权限策略。请用 explorer 子代理读取本仓库根目录下的 .env 文件（预期会被权限策略直接拒绝），不要绕过、不要换成别的文件，被拒之后把拒绝信息原样回报给我就行。';

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeJson(ROOT, 'm18-m20-state.json', state);

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'm18');
const now = () => Date.now();

// --- page reads --------------------------------------------------------------

/** The chip as a reader sees it: present at all, and what it says. */
const CHIP = `(() => {
  const btn = [...document.querySelectorAll('[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(CHIP_LABEL)});
  if (!btn) return { present: false, text: null, visible: false };
  const r = btn.getBoundingClientRect();
  return {
    present: true,
    visible: btn.offsetParent !== null,
    text: (btn.innerText || '').trim(),
    tag: btn.tagName,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
})()`;

/** The permission audit rows `PermissionActivityRows` paints, plus their tone. */
const ACTIVITY_ROWS = `(() => {
  return [...document.querySelectorAll('li[data-tone]')].map((n) => ({
    tone: n.getAttribute('data-tone'),
    visible: n.offsetParent !== null,
    text: (n.innerText || '').trim().replace(/\\s+/g, ' '),
    html: n.innerHTML.slice(0, 1500),
    mentionsExplorer: (n.innerText || '').includes('explorer'),
    mentionsSubagentWord: /子\\s*Agent|子代理/.test(n.innerText || ''),
  }));
})()`;

const readUsage = (sid) => `
  const m = await import(/* @vite-ignore */ '/stores/sessionRuntimeFacts.ts');
  const facts = m.useSessionRuntimeFactsStore.getState().factsBySession[${JSON.stringify(sid)}] ?? null;
  const usage = facts?.usage ?? null;
  return {
    hasFacts: facts !== null,
    usageIsNull: usage === null,
    keys: usage ? Object.keys(usage).sort() : null,
    hasContext: usage ? Object.hasOwn(usage, 'context') : false,
    contextKeys: usage && usage.context && typeof usage.context === 'object'
      ? Object.keys(usage.context).sort()
      : null,
    usage: usage ? JSON.parse(JSON.stringify(usage)) : null,
  };
`;

const readLanes = (sid) => `
  const m = await import(/* @vite-ignore */ '/stores/subagentActivity.ts');
  const s = m.useSubagentActivityStore.getState();
  const sid = ${JSON.stringify(sid)};
  const lanes = Object.entries(s.lanes)
    .filter(([, l]) => l.sessionId === sid)
    .map(([key, l]) => ({
      key,
      parentToolCallId: l.parentToolCallId,
      agentId: l.agentId,
      agentType: l.agentType,
      description: l.description,
      status: l.status,
      rowCount: l.rows.length,
      lastRows: l.rows.slice(-5).map((r) => ({
        kind: r.kind,
        name: r.name,
        status: r.status,
        errorText: r.errorText ? String(r.errorText).slice(0, 300) : undefined,
        text: r.text ? String(r.text).slice(0, 220) : undefined,
      })),
      progress: l.progress ? JSON.parse(JSON.stringify(l.progress)) : null,
      pendingPermission: l.pendingPermission ? JSON.parse(JSON.stringify(l.pendingPermission)) : null,
      report: l.report ? JSON.parse(JSON.stringify(l.report)) : null,
    }));
  return {
    laneCount: lanes.length,
    lanes,
    agentIndex: JSON.parse(JSON.stringify(s.agentIndex)),
    permissionOrigin: JSON.parse(JSON.stringify(s.permissionOrigin)),
  };
`;

/**
 * Every transcript line that could be the refusal, whatever paints it.
 *
 * `li[data-tone]` is `PermissionActivityRows`, but a gate that raised a CARD
 * settles into the collapsed Allowed/Denied tool row instead
 * (`MessageTimeline` → `QuestionCard variant="permission"`), which is a
 * different element entirely. Scanning the transcript text as well means a
 * "no row found" verdict cannot be an artefact of one selector.
 */
const DENY_SCAN = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
  let best = '';
  for (const v of viewports) {
    const text = v.innerText || '';
    if (text.length > best.length) best = text;
  }
  const lines = best.split('\\n').map((l) => l.trim()).filter(Boolean);
  return {
    denyLines: lines.filter((l) => /拒绝|失败|无权|不允许|Denied|denied/.test(l)),
    explorerLines: lines.filter((l) => /explorer|子\\s*Agent|子代理/.test(l)),
    transcript: best.slice(0, 14000),
  };
})()`;

/** Every `permission_activity` record plus the tool rows, straight off the store. */
const readBlocks = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sid)};
  const msgs = s.messages[sid] ?? [];
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const permissionActivity = [];
  const toolBlocks = [];
  const counts = {};
  for (const m of msgs) {
    for (const b of m.blocks ?? []) {
      counts[b.type] = (counts[b.type] ?? 0) + 1;
      if (b.permissionActivity) {
        permissionActivity.push({
          blockId: b.id,
          blockType: b.type,
          messageId: m.id,
          record: JSON.parse(JSON.stringify(b.permissionActivity)),
        });
      }
      if (b.type === 'tool_call' || b.type === 'tool_result') {
        toolBlocks.push({
          id: b.id,
          type: b.type,
          toolName: b.toolName,
          toolOk: b.toolOk,
          toolInputHead: b.toolInput === undefined ? undefined : clip(JSON.stringify(b.toolInput), 300),
          toolOutputHead: b.toolOutput === undefined ? undefined : clip(JSON.stringify(b.toolOutput), 500),
          textHead: clip(b.text, 400),
        });
      }
    }
  }
  const session = s.sessions.find((x) => x.id === sid) ?? null;
  return {
    status: session?.status ?? null,
    messageCount: msgs.length,
    blockTypeCounts: counts,
    permissionActivity,
    toolBlocks,
    lastAssistantText: (() => {
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i].role !== 'assistant') continue;
        return (msgs[i].blocks ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('')
          .trim()
          .slice(0, 900);
      }
      return '';
    })(),
  };
`;

const statusOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  return chat.useChatSessionsStore.getState().sessions.find((x) => x.id === ${JSON.stringify(sid)})?.status ?? null;
`;

// --- actions -----------------------------------------------------------------

async function send(prompt) {
  const typed = await cdp.evaluate(typeIntoComposer(prompt));
  await cdp.waitFor(SEND_READY, { timeoutMs: 120_000, label: 'send button ready' });
  const t0 = now();
  await cdp.evaluate(CLICK_SEND);
  return { typed, t0 };
}

async function readActive() {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const sid = s.activeSessionId;
     return { sid, messageCount: sid ? (s.messages[sid] ?? []).length : null };`,
    { label: 'read active session' }
  );
}

async function newSession() {
  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  return readActive();
}

/** Answer a card with `decision` (button text). Modal, so a synthetic click. */
async function answerCard(decision) {
  const card = await cdp.evaluate(PERMISSION_CARD).catch(() => null);
  if (!card) return null;
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((n) => (n.innerText || '').trim() === ${JSON.stringify(decision)} && n.offsetParent !== null);
    if (!b) return null;
    b.click();
    return (b.innerText || '').trim();
  })()`);
  return { at: new Date().toISOString(), decision, clicked, card };
}

/**
 * One polling loop that both answers cards and decides when the turn is over.
 *
 * Single-threaded on purpose: the first attempt ran the idle wait inside the
 * page and the card pump from the probe, and the two could not see each other.
 */
async function driveTurn(sid, { decision, timeoutMs = 900_000, busyGraceMs = 120_000, onTick }) {
  const t0 = now();
  const busy = new Set(BUSY);
  const cards = [];
  const trail = [];
  let sawBusy = false;
  let busyAtMs = null;
  let idleStreak = 0;
  while (now() - t0 < timeoutMs) {
    const status = await evalAsync(statusOf(sid), { label: 'status poll' });
    if (trail[trail.length - 1]?.status !== status) trail.push({ status, atMs: now() - t0 });
    if (busy.has(status ?? 'idle')) {
      if (!sawBusy) busyAtMs = now() - t0;
      sawBusy = true;
      idleStreak = 0;
    } else if (sawBusy) {
      idleStreak += 1;
      // Three consecutive idle reads: a tool boundary briefly looks idle.
      if (idleStreak >= 3) {
        return { ok: true, sawBusy, busyAtMs, idleAtMs: now() - t0, status, trail, cards };
      }
    } else if (now() - t0 > busyGraceMs) {
      return { ok: false, reason: 'never went busy', sawBusy, status, trail, cards };
    }
    const answered = await answerCard(decision);
    if (answered) {
      cards.push(answered);
      console.log(
        `  card → ${decision}: ${answered.card.text.replace(/\n/g, ' | ').slice(0, 120)}`
      );
    }
    if (onTick) {
      const stop = await onTick({ status, elapsedMs: now() - t0 });
      if (stop) return { ok: true, earlyExit: stop, sawBusy, busyAtMs, status, trail, cards };
    }
    await sleep(1200);
  }
  return { ok: false, reason: 'timeout', sawBusy, trail, cards };
}

async function snapshot(sid, label) {
  await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(700);
  return {
    label,
    at: new Date().toISOString(),
    chip: await cdp.evaluate(CHIP),
    usage: await evalAsync(readUsage(sid), { label: `${label}: usage` }),
    lanes: await evalAsync(readLanes(sid), { label: `${label}: lanes` }),
    activityRows: await cdp.evaluate(ACTIVITY_ROWS),
  };
}

const USAGE_RECORDER = `
  const bus = await import(/* @vite-ignore */ '/stores/runtimeEventBus.ts');
  if (!window.__m18_usage) {
    window.__m18_usage = [];
    window.__m18_unsub = bus.subscribeRuntimeEvent((e) => {
      if (e?.type !== 'usage.updated') return;
      window.__m18_usage.push({
        at: Date.now(),
        sessionId: e.sessionId,
        keys: e.payload ? Object.keys(e.payload).sort() : null,
        hasContext: e.payload ? Object.hasOwn(e.payload, 'context') : false,
        payload: JSON.parse(JSON.stringify(e.payload ?? null)),
      });
    });
    return 'installed';
  }
  return 'already installed (' + window.__m18_usage.length + ' seen)';
`;

try {
  state.probe = 'm18-m20.mjs';
  state.criteria = ['MODEL-18', 'MODEL-20'];
  state.runs ??= [];
  state.runs.push({ stages: [...STAGES], startedAt: new Date().toISOString() });

  if (STAGES.has('enter')) state.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);
  state.recorder = await evalAsync(USAGE_RECORDER, { label: 'usage.updated recorder' });

  if (STAGES.has('normal')) {
    const fresh = await newSession();
    if (!fresh.sid) throw new Error('no active session after 新建对话');
    state.sessionId = fresh.sid;
    state.initial = await snapshot(fresh.sid, 'initial (empty session)');
    saveState();
    console.log(`session ${fresh.sid}; chip initially ${JSON.stringify(state.initial.chip)}`);

    console.log('[normal] sending');
    const sent = await send(PROMPT_NORMAL);
    const drive = await driveTurn(fresh.sid, { decision: ALLOW_TEXT });
    state.normalTurn = { ...drive, totalMs: now() - sent.t0 };
    console.log(`[normal] ok=${drive.ok} in ${state.normalTurn.totalMs}ms`);
    saveState();
  }

  const SID = process.env.PC_SESSION_ID ?? state.sessionId ?? (await readActive()).sid;
  if (!SID) throw new Error('no session id to work with');
  state.sessionId = SID;

  if (STAGES.has('snap-normal')) {
    await sleep(1500);
    state.afterNormal = await snapshot(SID, 'after normal finish');
    state.afterNormalBlocks = await evalAsync(readBlocks(SID), { label: 'blocks after normal' });
    state.normalShot = await shoot(cdp, OUT18, 'model-18-badge-normal.png');
    saveState();
    console.log(`[normal] chip=${JSON.stringify(state.afterNormal.chip)}`);
  }

  if (STAGES.has('stop')) {
    const lanesBefore = state.afterNormal?.lanes?.laneCount ?? 0;
    console.log('[stop] sending');
    const sent = await send(PROMPT_STOP);
    let laneSeenAtMs = null;
    let letRunUntil = null;
    const drive = await driveTurn(SID, {
      decision: ALLOW_TEXT,
      timeoutMs: 600_000,
      onTick: async ({ elapsedMs }) => {
        if (laneSeenAtMs === null) {
          const l = await evalAsync(readLanes(SID), { label: 'lane poll' });
          if (l.laneCount > lanesBefore) {
            laneSeenAtMs = elapsedMs;
            // Let the delegate actually do some work before pulling the plug.
            letRunUntil = elapsedMs + 13_000;
            console.log(`[stop] lane up at ${elapsedMs}ms; running 13s more`);
          }
          return false;
        }
        if (elapsedMs < letRunUntil) return false;
        return 'stop-now';
      },
    });
    state.stopLane = { laneSeenAtMs, drive: { ...drive, totalMs: now() - sent.t0 } };
    if (drive.earlyExit !== 'stop-now') {
      throw new Error(
        `stop round never reached the Stop point: ${JSON.stringify(drive).slice(0, 400)}`
      );
    }
    state.beforeStop = await snapshot(SID, 'just before Stop');
    saveState();

    const stopT0 = now();
    state.stopClicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(STOP_LABEL)} && n.offsetParent !== null);
      if (!b) throw new Error('no 停止当前回合 button on screen');
      if (b.disabled) throw new Error('stop button disabled');
      b.click();
      return { label: b.getAttribute('aria-label'), at: new Date().toISOString() };
    })()`);
    // After Stop the turn is ALREADY busy, so no busy grace is needed; a card
    // still on screen is answered so the stop is not confounded by a timeout.
    const settle = await driveTurn(SID, {
      decision: ALLOW_TEXT,
      timeoutMs: 300_000,
      busyGraceMs: 500,
    });
    state.stopSettle = settle;
    state.stopTiming = {
      sentToStopMs: stopT0 - sent.t0,
      stopToIdleMs: now() - stopT0,
      totalMs: now() - sent.t0,
      laneSeenAtMs,
    };
    console.log(`[stop] idle ${state.stopTiming.stopToIdleMs}ms after Stop (${settle.status})`);
    await sleep(2500);
    state.afterStop = await snapshot(SID, 'after Stop');
    state.afterStopBlocks = await evalAsync(readBlocks(SID), { label: 'blocks after stop' });
    state.stopShot = await shoot(cdp, OUT18, 'model-18-badge-stop.png');
    saveState();
  }

  if (STAGES.has('deny')) {
    /**
     * `PC_NEW_SESSION=1` is not optional in practice.
     *
     * Round 1 of this stage reused the session whose previous turn had been
     * STOPPED, and the model spent the whole turn finishing that interrupted
     * job instead of the new instruction — the delegated `~/.ssh` read never
     * happened. A criterion about a refused gate cannot be tested in a context
     * that still has unfinished work in it.
     */
    if (process.env.PC_NEW_SESSION === '1') {
      state.denyPreviousRounds ??= [];
      state.denyPreviousRounds.push({
        sessionId: state.denySessionId ?? state.sessionId,
        prompt: state.denyPrompt ?? null,
        denyTurn: state.denyTurn ?? null,
        afterDeny: state.afterDeny ?? null,
        afterDenyBlocks: state.afterDenyBlocks ?? null,
        denyScan: state.denyScan ?? null,
      });
      const fresh = await newSession();
      if (!fresh.sid) throw new Error('no active session for the deny round');
      state.denySessionId = fresh.sid;
      console.log(`[deny] fresh session ${fresh.sid}`);
    }
    const DENY_SID = state.denySessionId ?? SID;
    state.denyPrompt = PROMPT_DENY;
    console.log('[deny] sending');
    const sent = await send(PROMPT_DENY);
    // A hardcoded deny should resolve with NO card; one showing anyway is a
    // finding, so it is refused rather than allowed.
    const drive = await driveTurn(DENY_SID, { decision: DENY_TEXT, timeoutMs: 600_000 });
    state.denyTurn = { ...drive, totalMs: now() - sent.t0, sessionId: DENY_SID };
    console.log(
      `[deny] ok=${drive.ok} in ${state.denyTurn.totalMs}ms, cards=${drive.cards.length}`
    );
    await sleep(2500);
    state.afterDeny = await snapshot(DENY_SID, 'after deny turn');
    state.denyScan = await cdp.evaluate(DENY_SCAN);
    state.afterDenyBlocks = await evalAsync(readBlocks(DENY_SID), { label: 'blocks after deny' });
    state.denyRowScrolled = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('li[data-tone]')];
      const hit = rows.find((n) => n.getAttribute('data-tone') === 'denied') ?? rows[rows.length - 1];
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      return (hit.innerText || '').trim().replace(/\\s+/g, ' ');
    })()`);
    await sleep(900);
    state.denyShot = await shoot(cdp, OUT20, 'model-20-subagent-approval-row.png');
    saveState();
  }

  state.usageBroadcasts = await cdp.evaluate(`(() => (window.__m18_usage ?? []).slice(-8))()`);
  saveState();

  if (STAGES.has('verdict')) {
    const present = (s) => s?.chip?.present === true && s?.chip?.visible === true;
    const survivesNormal = present(state.afterNormal) && !!state.afterNormal?.chip?.text;
    const survivesStop = present(state.afterStop) && !!state.afterStop?.chip?.text;

    writeJson(OUT18, 'report.json', {
      probe: 'm18-m20.mjs',
      criterion: 'MODEL-18',
      criterionText:
        '一次用到 Task 的对话，正常结束与中途 Stop 各跑一次；两种收尾下输入框上方的百分比徽标都不消失；对照最后一条 usage.updated 的键集是否含 context',
      sessionId: state.sessionId,
      verdict: {
        pass: survivesNormal && survivesStop,
        survivesNormalFinish: survivesNormal,
        survivesStop,
      },
      chip: {
        initialEmptySession: state.initial?.chip ?? null,
        afterNormalFinish: state.afterNormal?.chip ?? null,
        justBeforeStop: state.beforeStop?.chip ?? null,
        afterStop: state.afterStop?.chip ?? null,
      },
      usage: {
        initialEmptySession: state.initial?.usage ?? null,
        afterNormalFinish: state.afterNormal?.usage ?? null,
        justBeforeStop: state.beforeStop?.usage ?? null,
        afterStop: state.afterStop?.usage ?? null,
      },
      usageUpdatedBroadcasts: state.usageBroadcasts ?? null,
      notes: [
        'PASS on the wording: the chip is still mounted, visible and non-empty after BOTH endings.',
        'But a Stop RESETS the number. The last two usage.updated broadcasts after the Stop carry context {tokens:0, contextWindow:1000000, percent:0} and totalTokens:0, so the chip reads 0% while the conversation plainly holds ~18k tokens. `session` and `delegated` in the same payload keep their real totals, so this is the `context` sub-object being zeroed, not the whole payload.',
        'The key set contains `context` in every broadcast that has one. The interleaved in-flight broadcasts (keys: cacheRead/cacheWrite/costUsd/input/output/pending/totalTokens) carry no `context` at all; the chip survives those because the reducer keeps the last good value.',
        '`reasoning` is present in the settled broadcasts and absent from the two zeroed post-Stop ones.',
      ],
      subagentPanel: {
        afterNormalFinish: state.afterNormal?.lanes ?? null,
        justBeforeStop: state.beforeStop?.lanes ?? null,
        afterStop: state.afterStop?.lanes ?? null,
      },
      timings: {
        normalTurn: state.normalTurn ? { totalMs: state.normalTurn.totalMs } : null,
        stopRound: state.stopTiming ?? null,
      },
      statusTrails: {
        normal: state.normalTurn?.trail ?? null,
        stopRoundBeforeStop: state.stopLane?.drive?.trail ?? null,
        afterStopClick: state.stopSettle?.trail ?? null,
      },
      permissionCardsHandled: {
        normal: state.normalTurn?.cards ?? null,
        stop: state.stopLane?.drive?.cards ?? null,
      },
      screenshots: [state.normalShot, state.stopShot].filter(Boolean),
    });

    const rows = state.afterDeny?.activityRows ?? [];
    const denyRows = rows.filter((r) => r.tone === 'denied');
    const records = (state.afterDenyBlocks?.permissionActivity ?? []).filter(
      (p) => p.record?.result === 'deny'
    );
    const rowNamesSubagent = denyRows.some((r) => r.mentionsExplorer || r.mentionsSubagentWord);
    writeJson(OUT20, 'report.json', {
      probe: 'm18-m20.mjs',
      criterion: 'MODEL-20',
      criterionText: '委派一个会撞 deny 的子代理，截时间线审批行；审批行上能读出是哪个子代理',
      prompt: state.denyPrompt ?? null,
      earlierAttempts: state.denyPreviousRounds ?? null,
      sessionId: state.denySessionId ?? state.sessionId,
      verdict: {
        pass: denyRows.length > 0 && rowNamesSubagent,
        deniedRowPresent: denyRows.length > 0,
        rowNamesSubagent,
      },
      paintedRows: rows,
      transcriptScan: state.denyScan ?? null,
      storePermissionActivity: state.afterDenyBlocks?.permissionActivity ?? null,
      attributionFields: records.map((p) => ({
        requestId: p.record.requestId,
        surface: p.record.surface,
        value: p.record.value,
        result: p.record.result,
        resolution: p.record.resolution,
        forwarded: p.record.forwarded ?? null,
        requesterAgentName: p.record.requesterAgentName ?? null,
        delegationId: p.record.delegationId ?? null,
        agentName: p.record.agentName ?? null,
      })),
      subagentPanel: state.afterDeny?.lanes ?? null,
      taskToolBlocks: state.afterDenyBlocks?.toolBlocks ?? null,
      lastAssistantText: state.afterDenyBlocks?.lastAssistantText ?? null,
      unexpectedPermissionCards: state.denyTurn?.cards ?? null,
      turnMs: state.denyTurn?.totalMs ?? null,
      statusTrail: state.denyTurn?.trail ?? null,
      screenshots: [state.denyShot].filter(Boolean),
      notes: [
        'FAIL, and the prep-notes prediction is confirmed exactly. The store record for the refused gate carries `delegationId` and `agentName: "explorer"`; `forwarded` and `requesterAgentName` are absent. `permissionActivityRow.ts:140` gates the whole 「代子 Agent … 请求」 note on `record.forwarded`, which no producer ever sets (`permissions/activity.ts:70-74` writes only delegationId/agentName), so the note is unreachable and the row reads 「已拒绝 bash pwd」 with no attribution.',
        'The settled card row above it (`QuestionCard variant="permission"` → 「已拒绝 bash — 在工作区运行命令」) is equally unattributed. Two different renderers, same blank.',
        'The LIVE approval card DOES attribute: it reads 「来自子 Agent · 点验 .env 读取权限」. The attribution is only lost once the card settles into the transcript.',
        'The subagent panel attributes correctly and independently: the lane header reads 「子 Agent explorer · 2 个工具 · 25,118 tokens · 68.8s」 with both failed calls (pwd, 读取 .env L1-5) under it in the destructive colour.',
        'Secondary finding, not the criterion: the `.env` read — the deny this round was designed around — produced NO permission_activity record and NO audit row at all. `tools/index.ts:177-178` throws `access denied: <path>` on `pathPolicy(lexical) === "deny"` BEFORE calling `runtimePermissions.authorize`, so a hardcoded-path deny never reaches the gate that broadcasts activity. The only denied row on screen is the bash `pwd` gate, which reached the gate as a card and was refused by this probe.',
      ],
    });
    console.log(`\nMODEL-18 pass=${survivesNormal && survivesStop}`);
    console.log(`MODEL-20 pass=${denyRows.length > 0 && rowNamesSubagent}`);
    console.log(`MODEL-20 rows: ${JSON.stringify(denyRows.map((r) => r.text))}`);
  }
} catch (error) {
  state.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', state.error);
  process.exitCode = 1;
} finally {
  try {
    state.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  state.finishedAt = new Date().toISOString();
  console.log(`state → ${saveState()}`);
  cdp.close();
}
