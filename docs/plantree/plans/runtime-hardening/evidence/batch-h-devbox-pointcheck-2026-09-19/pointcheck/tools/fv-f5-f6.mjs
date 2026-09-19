#!/usr/bin/env node
/**
 * fv-f5-f6.mjs — re-check F5 (context chip after Stop) and F6 (subagent
 * attribution on the settled approval row) against the fixes committed as
 * f059a8ae / 6ea3fb2d.
 *
 * Derived from `m18-m20.mjs`; the same stage-over-a-state-file shape (a real
 * model turn costs minutes, so a later fix must not throw away a finished one),
 * the same two traps handled: "idle right after Send is a lie" (wait for BUSY
 * first, then three consecutive idle reads) and "a settled turn folds its own
 * evidence into the 「Worked for …」 `<details>`" (expand before every read and
 * every screenshot).
 *
 * What changed versus the original probe:
 *
 *  - F5 runs in a FRESH session and the criteria are now about the NUMBER, not
 *    just the chip's presence: the text before and after Stop must match and
 *    must not be 0%, and every `usage.updated` broadcast that arrives after the
 *    Stop click is recorded with its `context` sub-object.
 *  - F5 waits for the chip to carry a figure before pulling the plug. With the
 *    fix a turn stopped before ANY turn_end simply omits `context` (no claim of
 *    zero occupancy), which is correct but untestable against "前后一致"; the
 *    probe records which of the two branches it actually exercised.
 *  - F6 screenshots the live permission card BEFORE refusing it, and the
 *    verdict now also requires the painted row to name the subagent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, DEBUG_PORT, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import {
  ALLOW_TEXT,
  CLICK_SEND,
  EXPAND_WORK_GROUPS,
  PERMISSION_CARD,
  SEND_READY,
  enterApp,
  makeEval,
  shoot,
  typeIntoComposer,
  writeJson,
} from './pc-lib.mjs';

const OUT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/fix-verify';
const STATE_FILE = path.join(OUT, 'fv-f5-f6-state.json');
const STAGES = new Set((process.env.PC_STAGES ?? 'enter,f5,f6,verdict').split(','));

const DENY_TEXT = '直接拒绝';
const STOP_LABEL = '停止当前回合';
const CHIP_LABEL = '上下文占用';
const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

/** Deliberately worded differently from the 09-19 morning run's Task prompt. */
const PROMPT_F5 =
  process.env.PC_PROMPT_F5 ??
  '请委派 explorer 子代理，把 src/runtime/plugins/ 里每个子目录的 index.ts 都读一遍，然后按子目录名逐条给我一句话的职责说明。';
const PROMPT_F6 =
  process.env.PC_PROMPT_F6 ??
  '我在点验权限策略，预期会被拒绝，不要绕过：用 explorer 子代理读一下 /home/ai/code/ai-client/.env 的内容并告诉我结果。';
/** Fallback: forces a bash call, which is the gate that actually raises a card. */
const PROMPT_F6B =
  process.env.PC_PROMPT_F6B ??
  '我在点验权限策略，预期会被拒绝，不要绕过：请让 explorer 子代理在 /home/ai/code/ai-client 目录下用 bash 执行 `cat .env`，把闸门返回的原始拒绝信息回报给我。';
/**
 * Second fallback, and the one the criterion actually needs.
 *
 * Rounds 1 and 2 both failed to produce an audit row for opposite reasons:
 * round 1 the model refused to delegate at all (the 「不要绕过」 framing reads as
 * "do not use a subagent to get around the gate"), round 2 the delegate DID
 * run `cat .env` and was refused by the HARDCODED path table — which
 * short-circuits before `runtimePermissions.authorize` and therefore
 * broadcasts no activity at all (F7, unfixed). A row only exists for a call
 * that reaches the ASK gate, so this round asks for an innocuous bash command
 * and refuses it at the card, which is the shape the 09-19 morning run caught
 * by accident through the delegate's own `pwd`.
 */
const PROMPT_F6C =
  process.env.PC_PROMPT_F6C ??
  '我在点验「子代理请求权限时，时间线上能不能看出是哪个子代理」。请派 explorer 子代理用 bash 跑一条最简单的命令（就 `pwd`，不要加别的）。我会在弹出的授权卡上点拒绝——这是点验的预期行为，不要重试、不要换别的工具绕过，被拒之后把拒绝结果回报给我就行。';

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeJson(OUT, 'fv-f5-f6-state.json', state);

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'fv56');
const now = () => Date.now();

// --- page reads --------------------------------------------------------------

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

const ACTIVITY_ROWS = `(() => {
  return [...document.querySelectorAll('li[data-tone]')].map((n) => ({
    tone: n.getAttribute('data-tone'),
    visible: n.offsetParent !== null,
    text: (n.innerText || '').trim().replace(/\\s+/g, ' '),
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
    keys: usage ? Object.keys(usage).sort() : null,
    hasContext: usage ? Object.hasOwn(usage, 'context') : false,
    context: usage && usage.context ? JSON.parse(JSON.stringify(usage.context)) : null,
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
      agentId: l.agentId,
      agentType: l.agentType,
      description: l.description,
      status: l.status,
      rowCount: l.rows.length,
      lastRows: l.rows.slice(-5).map((r) => ({ kind: r.kind, name: r.name, status: r.status })),
    }));
  return { laneCount: lanes.length, lanes };
`;

const readBlocks = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sid)};
  const msgs = s.messages[sid] ?? [];
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const permissionActivity = [];
  const toolBlocks = [];
  for (const m of msgs) {
    for (const b of m.blocks ?? []) {
      if (b.permissionActivity) {
        permissionActivity.push({
          blockId: b.id,
          messageId: m.id,
          record: JSON.parse(JSON.stringify(b.permissionActivity)),
        });
      }
      if (b.type === 'tool_call' || b.type === 'tool_result') {
        toolBlocks.push({
          type: b.type,
          toolName: b.toolName,
          toolOk: b.toolOk,
          toolInputHead: b.toolInput === undefined ? undefined : clip(JSON.stringify(b.toolInput), 240),
          toolOutputHead: b.toolOutput === undefined ? undefined : clip(JSON.stringify(b.toolOutput), 400),
        });
      }
    }
  }
  const session = s.sessions.find((x) => x.id === sid) ?? null;
  return {
    status: session?.status ?? null,
    messageCount: msgs.length,
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

const USAGE_RECORDER = `
  const bus = await import(/* @vite-ignore */ '/stores/runtimeEventBus.ts');
  if (!window.__fv_usage) {
    window.__fv_usage = [];
    window.__fv_unsub = bus.subscribeRuntimeEvent((e) => {
      if (e?.type !== 'usage.updated') return;
      window.__fv_usage.push({
        at: Date.now(),
        sessionId: e.sessionId,
        keys: e.payload ? Object.keys(e.payload).sort() : null,
        hasContext: e.payload ? Object.hasOwn(e.payload, 'context') : false,
        context: e.payload && e.payload.context ? JSON.parse(JSON.stringify(e.payload.context)) : null,
        totalTokens: e.payload ? e.payload.totalTokens ?? null : null,
      });
    });
    return 'installed';
  }
  return 'already installed (' + window.__fv_usage.length + ' seen)';
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

/**
 * Answer a live card. `shotName` captures it BEFORE the decision, because the
 * card is the only place the gate's own wording and its 「来自子 Agent」 line
 * are visible — once answered it settles into a one-line tool row.
 */
async function answerCard(decision, shotName) {
  const card = await cdp.evaluate(PERMISSION_CARD).catch(() => null);
  if (!card) return null;
  let screenshot = null;
  if (shotName) {
    screenshot = await shoot(cdp, OUT, shotName);
  }
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((n) => (n.innerText || '').trim() === ${JSON.stringify(decision)} && n.offsetParent !== null);
    if (!b) return null;
    b.click();
    return (b.innerText || '').trim();
  })()`);
  return { at: new Date().toISOString(), decision, clicked, card, screenshot };
}

async function driveTurn(sid, { decision, cardShot, timeoutMs = 900_000, busyGraceMs = 120_000, onTick }) {
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
      if (idleStreak >= 3) {
        return { ok: true, sawBusy, busyAtMs, idleAtMs: now() - t0, status, trail, cards };
      }
    } else if (now() - t0 > busyGraceMs) {
      return { ok: false, reason: 'never went busy', sawBusy, status, trail, cards };
    }
    const answered = await answerCard(decision, cardShot ? `${cardShot}-${cards.length + 1}.png` : null);
    if (answered) {
      cards.push(answered);
      console.log(`  card → ${decision}: ${answered.card.text.replace(/\n/g, ' | ').slice(0, 140)}`);
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
    atMs: now(),
    chip: await cdp.evaluate(CHIP),
    usage: await evalAsync(readUsage(sid), { label: `${label}: usage` }),
    lanes: await evalAsync(readLanes(sid), { label: `${label}: lanes` }),
    activityRows: await cdp.evaluate(ACTIVITY_ROWS),
  };
}

/** Run one deny round in a fresh session and record everything about it. */
async function denyRound(key, prompt) {
  const fresh = await newSession();
  if (!fresh.sid) throw new Error(`${key}: no active session`);
  console.log(`[${key}] fresh session ${fresh.sid}`);
  const sent = await send(prompt);
  const drive = await driveTurn(fresh.sid, {
    decision: DENY_TEXT,
    cardShot: `fix-f6-permission-card-${key}`,
    timeoutMs: 600_000,
  });
  await sleep(2500);
  const after = await snapshot(fresh.sid, `${key}: after deny turn`);
  const blocks = await evalAsync(readBlocks(fresh.sid), { label: `${key}: blocks` });
  const scrolled = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li[data-tone]')];
    const hit = rows.find((n) => n.getAttribute('data-tone') === 'denied') ?? rows[rows.length - 1];
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    return (hit.innerText || '').trim().replace(/\\s+/g, ' ');
  })()`);
  await sleep(900);
  const shot = await shoot(cdp, OUT, 'fix-f6-subagent-row.png');
  return {
    key,
    prompt,
    sessionId: fresh.sid,
    turn: { ...drive, totalMs: now() - sent.t0 },
    after,
    blocks,
    scrolledRowText: scrolled,
    screenshot: shot,
  };
}

try {
  state.probe = 'fv-f5-f6.mjs';
  state.commits = { f5: 'f059a8ae', f6: '6ea3fb2d' };
  (state.runs ??= []).push({ stages: [...STAGES], startedAt: new Date().toISOString() });

  if (STAGES.has('enter')) state.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);
  state.recorder = await evalAsync(USAGE_RECORDER, { label: 'usage.updated recorder' });

  if (STAGES.has('f5')) {
    const fresh = await newSession();
    if (!fresh.sid) throw new Error('F5: no active session after 新建对话');
    state.f5SessionId = fresh.sid;
    state.f5Initial = await snapshot(fresh.sid, 'F5 initial (empty session)');
    state.f5Prompt = PROMPT_F5;
    saveState();
    console.log(`[f5] session ${fresh.sid}; chip ${JSON.stringify(state.f5Initial.chip)}`);

    const sent = await send(PROMPT_F5);
    let laneSeenAtMs = null;
    let chipSeenAtMs = null;
    const drive = await driveTurn(fresh.sid, {
      decision: ALLOW_TEXT,
      timeoutMs: 600_000,
      onTick: async ({ elapsedMs }) => {
        if (laneSeenAtMs === null) {
          const l = await evalAsync(readLanes(fresh.sid), { label: 'lane poll' });
          if (l.laneCount > 0) {
            laneSeenAtMs = elapsedMs;
            console.log(`[f5] subagent lane up at ${elapsedMs}ms`);
          }
          return false;
        }
        if (chipSeenAtMs === null) {
          const chip = await cdp.evaluate(CHIP);
          if (chip.present && chip.text) {
            chipSeenAtMs = elapsedMs;
            console.log(`[f5] chip reads "${chip.text}" at ${elapsedMs}ms`);
          }
        }
        // Stop 10s after the lane at the earliest; give the turn up to 90s more
        // to produce a first real figure so "before vs after" has something to
        // compare. Past that, stop anyway and record the no-figure branch.
        if (elapsedMs < laneSeenAtMs + 10_000) return false;
        if (chipSeenAtMs === null && elapsedMs < laneSeenAtMs + 90_000) return false;
        return 'stop-now';
      },
    });
    state.f5Lane = { laneSeenAtMs, chipSeenAtMs, drive: { ...drive, totalMs: now() - sent.t0 } };
    if (drive.earlyExit !== 'stop-now') {
      throw new Error(`F5 never reached the Stop point: ${JSON.stringify(drive).slice(0, 400)}`);
    }
    state.f5BeforeStop = await snapshot(fresh.sid, 'F5 just before Stop');
    state.f5BeforeStopShot = await shoot(cdp, OUT, 'fix-f5-badge-before-stop.png');
    saveState();

    const stopMark = now();
    const stopT0 = stopMark;
    state.f5StopClicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(STOP_LABEL)} && n.offsetParent !== null);
      if (!b) throw new Error('no 停止当前回合 button on screen');
      if (b.disabled) throw new Error('stop button disabled');
      b.click();
      return { label: b.getAttribute('aria-label'), at: new Date().toISOString() };
    })()`);
    const settle = await driveTurn(fresh.sid, { decision: ALLOW_TEXT, timeoutMs: 300_000, busyGraceMs: 500 });
    state.f5Settle = settle;
    state.f5Timing = {
      sentToStopMs: stopT0 - sent.t0,
      stopToIdleMs: now() - stopT0,
      totalMs: now() - sent.t0,
      laneSeenAtMs,
      chipSeenAtMs,
    };
    console.log(`[f5] idle ${state.f5Timing.stopToIdleMs}ms after Stop (${settle.status})`);
    await sleep(3000);
    state.f5AfterStop = await snapshot(fresh.sid, 'F5 after Stop');
    state.f5AfterStopBlocks = await evalAsync(readBlocks(fresh.sid), { label: 'F5 blocks after stop' });
    state.f5Shot = await shoot(cdp, OUT, 'fix-f5-badge-after-stop.png');
    state.f5PostStopBroadcasts = await cdp.evaluate(
      `(() => (window.__fv_usage ?? []).filter((u) => u.at >= ${stopMark}))()`
    );
    state.f5AllBroadcasts = await cdp.evaluate(`(() => (window.__fv_usage ?? []).slice(-20))()`);
    saveState();
  }

  if (STAGES.has('f6')) {
    state.f6 = await denyRound('f6', PROMPT_F6);
    saveState();
    const rows = (state.f6.after?.activityRows ?? []).filter((r) => r.tone === 'denied');
    console.log(`[f6] denied rows: ${JSON.stringify(rows.map((r) => r.text))}`);
    if (rows.length === 0 && process.env.PC_F6_FALLBACK !== '0') {
      console.log('[f6] no denied row — running the bash-forced fallback round');
      state.f6b = await denyRound('f6b', PROMPT_F6B);
      saveState();
      const rows2 = (state.f6b.after?.activityRows ?? []).filter((r) => r.tone === 'denied');
      console.log(`[f6b] denied rows: ${JSON.stringify(rows2.map((r) => r.text))}`);
    }
  }

  if (STAGES.has('f6c')) {
    state.f6c = await denyRound('f6c', PROMPT_F6C);
    saveState();
    const rows = (state.f6c.after?.activityRows ?? []).filter((r) => r.tone === 'denied');
    console.log(`[f6c] denied rows: ${JSON.stringify(rows.map((r) => r.text))}`);
  }

  if (STAGES.has('verdict')) {
    const before = state.f5BeforeStop?.chip ?? null;
    const after = state.f5AfterStop?.chip ?? null;
    const afterCtx = state.f5AfterStop?.usage?.context ?? null;
    const measuredBranch = Boolean(before?.text);
    const f5Pass = measuredBranch
      ? before.text === after?.text && after?.text !== '0%' && (afterCtx?.tokens ?? 0) > 0
      : after?.text !== '0%';

    const winner = (() => {
      for (const key of ['f6c', 'f6', 'f6b']) {
        const round = state[key];
        if (!round) continue;
        const rows = (round.after?.activityRows ?? []).filter((r) => r.tone === 'denied');
        if (rows.length > 0) return { key, round, rows };
      }
      for (const key of ['f6c', 'f6b', 'f6']) {
        if (state[key]) return { key, round: state[key], rows: [] };
      }
      return null;
    })();
    const denyRows = winner?.rows ?? [];
    const records = (winner?.round?.blocks?.permissionActivity ?? []).filter(
      (p) => p.record?.result === 'deny'
    );
    const rowNamesSubagent = denyRows.some((r) => r.mentionsExplorer || r.mentionsSubagentWord);
    const storeNamesSubagent = records.some((p) => (p.record.agentName ?? '').trim().length > 0);

    state.verdict = {
      f5: {
        pass: f5Pass,
        branch: measuredBranch ? 'chip carried a figure before Stop' : 'no turn_end before Stop (context key omitted)',
        chipBeforeStop: before,
        chipAfterStop: after,
        contextBeforeStop: state.f5BeforeStop?.usage?.context ?? null,
        contextAfterStop: afterCtx,
        usageKeysAfterStop: state.f5AfterStop?.usage?.keys ?? null,
        postStopBroadcasts: state.f5PostStopBroadcasts ?? null,
        timing: state.f5Timing ?? null,
      },
      f6: {
        pass: denyRows.length > 0 && rowNamesSubagent && storeNamesSubagent,
        round: winner?.key ?? null,
        deniedRows: denyRows,
        allRows: winner?.round?.after?.activityRows ?? null,
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
        scrolledRowText: winner?.round?.scrolledRowText ?? null,
        lastAssistantText: winner?.round?.blocks?.lastAssistantText ?? null,
        turnMs: winner?.round?.turn?.totalMs ?? null,
      },
    };
    saveState();
    console.log(`\nF5 pass=${f5Pass} (${state.verdict.f5.branch})`);
    console.log(`  chip ${JSON.stringify(before?.text)} → ${JSON.stringify(after?.text)}; context after ${JSON.stringify(afterCtx)}`);
    console.log(`F6 pass=${state.verdict.f6.pass}; rows=${JSON.stringify(denyRows.map((r) => r.text))}`);
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
