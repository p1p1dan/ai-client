/**
 * Issue #9 (decision 173 §4.5): the Run panel's 「逐步缓存」 group and the
 * session's cache alert, as `runPanelModel.ts` derives them — the approved
 * prototype (`evidence/cache-chain-2026-10/`) with the user's changes of
 * 2026-10-10 (20 rows then 「查看更早的 N 步」; the alert at 2 rebuilds or
 * 100k rewritten, closable per chat; causes ordered; rows on settle only).
 *
 * The Chinese assertions go through the real catalog: they are the prototype's
 * own wording.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  initialMetadataRegistry,
  type MetadataRegistry,
  reduceMessageMetadata,
} from '@/components/chat/messageMetadata';
import {
  buildCacheRows,
  CACHE_ROWS_SHOWN,
  collectSettledSteps,
  deriveRunCacheView,
  foldCacheRows,
  formatApproxTokens,
  joinCacheList,
  orderCacheCauses,
  type RunCacheInput,
  resolveCacheGroupOpen,
} from '../surfaces/runPanelModel';
import {
  issue9Specs,
  issue9Steps,
  registryFrom,
  type StepSpec,
  stepMessageId,
  stepsFrom,
  TURN_START,
} from './cacheStepsFixture';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

function view(input: Partial<RunCacheInput> = {}, t = zh) {
  return deriveRunCacheView(
    { steps: [], hasUnlistedHistory: false, alertDismissed: false, ...input },
    t
  );
}

/** A plain step of a followed route that reused the cache: no `cache` block. */
function warm(turn: number, step: number, read: number, write: number, at: number): StepSpec {
  return { turn, step, read, write, at };
}

const MINUTE = 60_000;

describe('collectSettledSteps (issue #9)', () => {
  it('lists a step once its bill settles, never while only the first-byte tick is in', () => {
    const first = warm(1, 1, 0, 40_000, TURN_START);
    const second = warm(1, 2, 40_000, 2_000, TURN_START + 20_000);
    const running = registryFrom([first, { ...second, pending: true }]);
    expect(collectSettledSteps(running.byMessage).map((step) => step.step)).toEqual([1]);
    // The registry still holds the running step's prompt side for the turn head.
    expect(running.byMessage[stepMessageId(1, 2)]?.usage).toMatchObject({ cacheRead: 40_000 });
    expect(running.byMessage[stepMessageId(1, 2)]?.usageSettledAt).toBeUndefined();

    const settled = registryFrom([first, second]);
    expect(collectSettledSteps(settled.byMessage).map((step) => step.step)).toEqual([1, 2]);
  });

  it('skips a step cut before anything was reported, and every row that is not a DSH step', () => {
    let registry: MetadataRegistry = registryFrom([
      warm(1, 1, 0, 40_000, TURN_START),
      { ...warm(1, 2, 40_000, 2_000, TURN_START + 20_000), unreported: true },
    ]);
    registry = reduceMessageMetadata(registry, {
      type: 'message.started',
      sessionId: 's1',
      payload: { messageId: 'dsh-user-7', role: 'user' },
    });
    expect(collectSettledSteps(registry.byMessage).map((step) => step.messageId)).toEqual([
      stepMessageId(1, 1),
    ]);
  });

  it('dates each step by its message.started and measures the gap from the step before', () => {
    const steps = stepsFrom([
      warm(1, 1, 0, 40_000, TURN_START),
      { ...warm(1, 2, 40_000, 2_000, TURN_START + 20_000), unreported: true },
      warm(1, 3, 40_000, 3_000, TURN_START + 50_000),
    ]);
    expect(steps.map((step) => [step.turn, step.step, step.at, step.gapMs])).toEqual([
      [1, 1, TURN_START, null],
      // The cut step recorded no usage, so the chain's "step before" is step 1.
      [1, 3, TURN_START + 50_000, 50_000],
    ]);
    expect(steps[0]?.chain).toBe('dsh-aiclient-s1');
    expect(steps[0]?.model).toBe('claude-opus-5-5');
  });

  it('files the recorded bridge stream step by step, the turn on screen moving only on settle', () => {
    const events = (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../../../shared/__tests__/fixtures/dsh/stream.usage.json'),
          'utf8'
        )
      ) as { type: string; sessionId?: string; payload?: unknown }[]
    ).map((event, index) => ({ ...event, timestamp: TURN_START + index * 1_000 }));
    const foldUpTo = (end: number) =>
      events
        .slice(0, end)
        .reduce(
          (registry, event) => reduceMessageMetadata(registry, event),
          initialMetadataRegistry
        );
    const all = collectSettledSteps(foldUpTo(events.length).byMessage);
    expect(all.map((step) => [step.turn, step.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);

    // The second turn's first tick is in, its bill is not: still turn 1.
    const lastPending = events.findLastIndex(
      (event) =>
        event.type === 'usage.updated' && (event.payload as { pending?: boolean }).pending === true
    );
    const midTurn = view({ steps: collectSettledSteps(foldUpTo(lastPending + 1).byMessage) });
    expect(midTurn.group?.turn).toBe(1);
    expect(midTurn.group?.rows.map((row) => row.step)).toEqual([1, 2]);
  });
});

describe('deriveRunCacheView — issue #9’s turn (prototype state 3)', () => {
  const cache = view({ steps: issue9Steps() });
  const rows = cache.group?.rows ?? [];
  const row = (step: number) => rows.find((item) => item.step === step);

  it('lists every settled step, prompt = input + read + write, the header counting them', () => {
    expect(rows).toHaveLength(22);
    expect(row(15)).toMatchObject({ prompt: 174_880, read: 36_848, write: 138_030 });
    expect(cache.group?.summary).toBe('本回合 22 步');
    expect(cache.group?.anomalies).toBe(3);
    expect(row(15)?.title).toBe('第 15 步：提示词 174,880 · 缓存读 36,848 · 缓存写 138,030');
  });

  it('badges the first write grey, the three unexplained steps orange, the rest not at all', () => {
    expect(row(1)?.badge).toEqual({
      tone: 'secondary',
      text: '首次写入',
      tips: ['还没有可用的缓存，这一步的提示词全部写入缓存。'],
    });
    expect(row(1)?.warning).toBe(false);
    expect(
      rows.filter((item) => item.warning).map((item) => [item.step, item.badge?.text])
    ).toEqual([
      [15, '无法解释 · 重写约 133k'],
      [17, '读到第 14 步的前缀'],
      [20, '提示词变短 · −73k'],
    ]);
    expect(rows.filter((item) => item.badge === null)).toHaveLength(18);
  });

  it('explains each orange badge in its hover, with the exact figures', () => {
    expect(row(15)?.badge?.tips).toEqual([
      '上一步提示词 169,778，这一步只读到 36,848，约 133k 要重写。本地没有能解释的变化，多半是请求被分到了另一个上游。',
    ]);
    expect(row(17)?.badge?.tips).toEqual([
      '这一步读到的缓存（169,776）正好是第 14 步的长度，说明请求在两份缓存之间来回切换，多半是网关把请求分到了不同的上游。',
    ]);
    // The host cleared this request (`prefix: 'append'`), so 「（已校验）」 is earned.
    expect(row(20)?.badge?.tips).toEqual([
      '这一步的提示词比上一步少了 73,035。客户端只在末尾追加内容（已校验），变短说明上游丢掉了一部分历史，后面的内容要重新写入缓存。',
    ]);
  });

  it('says where the unexplained steps are, pointing at the alert while it shows', () => {
    expect(cache.group?.note).toBe('第 15、17、20 步找不到本地原因，见面板顶部的提示。');
    const dismissed = view({ steps: issue9Steps(), alertDismissed: true });
    expect(dismissed.group?.note).toBe('第 15、17、20 步找不到本地原因。');
  });

  it('raises the alert from the latest session totals, verified', () => {
    expect(cache.alert).toEqual({
      title: '这个会话的缓存多次被重建',
      body: '有 2 次重建找不到本地原因，共重写约 175k tokens。客户端每次都是在上一个请求的末尾追加（已校验），多半是网关把请求分到了不同的上游。',
    });
    expect(cache.prefix).toBe('verified');
    expect(cache.session).toMatchObject({
      unexplained: 3,
      unexplainedRebuilds: 2,
      unexplainedRewriteTokens: 174_678,
      gatewaySession: '5b3c9e2a-8f41-5d7e-9c3a-2e6f1b4d8a90',
    });
  });

  it('builds the copy’s verdict column with the figures in full', () => {
    expect(rows.filter((item) => item.verdict).map((item) => [item.step, item.verdict])).toEqual([
      [1, '首次写入'],
      [15, '无法解释，重写 132930'],
      [17, '读到第 14 步的前缀'],
      [20, '提示词变短 −73035'],
    ]);
  });
});

describe('deriveRunCacheView — badges and their hovers', () => {
  const turnOne = [
    warm(1, 1, 0, 40_000, TURN_START),
    warm(1, 2, 40_000, 2_000, TURN_START + MINUTE),
  ];

  it('reads a step of an earlier turn’s length as 「读到之前回合的前缀」', () => {
    const steps = stepsFrom([
      ...turnOne,
      {
        turn: 2,
        step: 1,
        read: 40_000,
        write: 9_000,
        at: TURN_START + 2 * MINUTE,
        cache: { kind: 'warm', explained: false, matched: { turn: 1, step: 1 }, prefix: 'append' },
      },
    ]);
    const badge = view({ steps }).group?.rows[0]?.badge;
    expect(badge?.text).toBe('读到之前回合的前缀');
    expect(badge?.tips[0]).toContain('之前回合某一步的长度');
    expect(view({ steps }).group?.rows[0]?.verdict).toBe('读到回合 1 第 1 步的前缀');
  });

  it('names the main cause of an explained step and lists every cause in order', () => {
    const steps = stepsFrom([
      ...turnOne,
      {
        turn: 2,
        step: 1,
        read: 0,
        write: 45_000,
        // 1 h 12 min after the step before started.
        at: TURN_START + MINUTE + 72 * MINUTE,
        cache: {
          kind: 'rebuild',
          explained: true,
          // First-sight order; the display order puts the model first.
          causes: ['ttl-expired', 'resume', 'model'],
          lost: 42_002,
          rewrite: 42_002,
          prevPrompt: 42_002,
        },
      },
    ]);
    const badge = view({ steps }).group?.rows[0]?.badge;
    expect(badge?.tone).toBe('info');
    expect(badge?.text).toBe('换了模型');
    expect(badge?.tips).toEqual([
      '换了模型。缓存不能跨模型复用，提示词要重新写入。',
      '引擎重启或会话重新打开后的第一步，没能沿用之前的缓存，提示词要重新写入。',
      '距离上一步过了 1 小时 12 分，超过缓存的保留时间，缓存已经过期，这一步要重新写入。',
    ]);
    expect(view({ steps }).group?.rows[0]?.verdict).toBe(
      '换了模型、恢复会话、闲置 1 小时 12 分，缓存已过期'
    );
  });

  it('says how long the chat sat idle when it knows, and only that it did when not', () => {
    const idle = (gapMinutes: number | null) => {
      const resumed: StepSpec = {
        turn: 2,
        step: 1,
        read: 0,
        write: 45_000,
        at: TURN_START + MINUTE + (gapMinutes ?? 0) * MINUTE,
        cache: { kind: 'rebuild', explained: true, causes: ['ttl-expired'], lost: 42_002 },
      };
      // No step before it in the registry (a restart in between): no gap to state.
      return view({
        steps: stepsFrom(gapMinutes === null ? [resumed] : [...turnOne, resumed]),
      }).group?.rows.at(-1)?.badge?.text;
    };
    expect(idle(72)).toBe('闲置 1 小时 12 分，缓存已过期');
    expect(idle(120)).toBe('闲置 2 小时，缓存已过期');
    expect(idle(8)).toBe('闲置 8 分钟，缓存已过期');
    expect(idle(null)).toBe('闲置超过缓存保留时间');
  });

  it('gives a first write a local event explains its cause, in blue', () => {
    // After a route switch the step before cached nothing: cold, with causes.
    const steps = stepsFrom([
      { ...warm(1, 1, 0, 0, TURN_START), model: 'glm-5.3' },
      {
        turn: 2,
        step: 1,
        read: 0,
        write: 45_000,
        at: TURN_START + MINUTE,
        cache: { kind: 'cold', explained: true, causes: ['route', 'model'] },
      },
    ]);
    const row = view({ steps }).group?.rows[0];
    expect(row?.badge).toEqual({
      tone: 'info',
      text: '换了模型',
      tips: [
        '换了模型。缓存不能跨模型复用，提示词要重新写入。',
        '请求换了路由或上下文窗口，没能沿用之前的缓存，提示词要重新写入。',
      ],
    });
    expect(row?.warning).toBe(false);
    expect(row?.verdict).toBe('换了模型、换了路由');
  });

  it('lets plan mode speak for the system prompt it changed', () => {
    const steps = stepsFrom([
      ...turnOne,
      {
        turn: 1,
        step: 3,
        read: 36_842,
        write: 44_533,
        at: TURN_START + 2 * MINUTE,
        cache: { kind: 'rebuild', explained: true, causes: ['system-prompt', 'plan-mode'] },
      },
    ]);
    const cache = view({ steps });
    expect(cache.group?.rows[2]?.badge).toEqual({
      tone: 'info',
      text: '计划模式切换',
      tips: ['进出计划模式会改系统提示词，之后的内容要重新写入缓存。'],
    });
    expect(cache.group?.note).toBe('这一回合的重建都有本地原因，不是上游的问题。');
    expect(cache.alert).toBeNull();
  });

  it('orders causes plan mode / system prompt > model > compaction > resume, series, seed > TTL > effort > tools > route > header', () => {
    expect(
      orderCacheCauses([
        'header',
        'route',
        'tools',
        'effort',
        'ttl-expired',
        'seed',
        'series',
        'resume',
        'compaction',
        'model',
        'system-prompt',
        'plan-mode',
        'model',
      ])
    ).toEqual([
      'plan-mode',
      'system-prompt',
      'model',
      'compaction',
      'resume',
      'series',
      'seed',
      'ttl-expired',
      'effort',
      'tools',
      'route',
      'header',
    ]);
  });

  it('drops 「（已校验）」 when the host could not tell, and blames no upstream when the client diverged', () => {
    const shrink = (prefix?: string) =>
      view({
        steps: issue9Steps((spec) =>
          spec.step === 20 && spec.cache ? { ...spec, cache: { ...spec.cache, prefix } } : spec
        ),
      });
    const unknown = shrink(undefined);
    expect(unknown.group?.rows[19]?.badge?.tips).toEqual([
      '这一步的提示词比上一步少了 73,035。客户端只在末尾追加内容，变短多半是上游丢掉了一部分历史，后面的内容要重新写入缓存。',
    ]);
    expect(unknown.prefix).toBe('unknown');
    expect(unknown.alert?.body).toBe(
      '有 2 次重建找不到本地原因，共重写约 175k tokens。多半是网关把请求分到了不同的上游。'
    );

    const diverged = shrink('diverged');
    expect(diverged.group?.rows[19]?.badge?.tips).toEqual([
      '这一步的提示词比上一步少了 73,035，后面的内容要重新写入缓存。',
      '这一步的请求没有接在上一个请求的末尾，问题可能出在客户端。',
    ]);
    expect(diverged.group?.rows[19]?.verdict).toBe('提示词变短 −73035（前缀不一致）');
    expect(diverged.prefix).toBe('diverged');
    expect(diverged.alert?.body).toBe(
      '有 2 次重建找不到本地原因，共重写约 175k tokens。其中有请求没有接在上一个请求的末尾，问题可能出在客户端。'
    );
  });

  it('puts no badge on a route the host does not follow, nor on a new turn’s normal shrink', () => {
    // GLM: no `cache` ever, however the numbers move — and no claim of reuse either.
    const steps = stepsFrom([
      { ...warm(1, 1, 0, 0, TURN_START), model: 'glm-5.3' },
      { ...warm(1, 2, 0, 0, TURN_START + MINUTE), model: 'glm-5.3', input: 90_000 },
      { ...warm(1, 3, 80_000, 0, TURN_START + 2 * MINUTE), model: 'glm-5.3' },
      // A new turn whose prompt dropped the old thinking: the host sends nothing.
      { ...warm(2, 1, 20_000, 0, TURN_START + 3 * MINUTE), model: 'glm-5.3' },
    ]);
    expect(buildCacheRows(steps).every((row) => row.badge === null && !row.warning)).toBe(true);
    const cache = view({ steps });
    expect(cache.group?.rows.map((row) => [row.step, row.badge])).toEqual([[1, null]]);
    expect(cache.group?.anomalies).toBe(0);
    expect(cache.group?.note).toBeNull();
    expect(cache.alert).toBeNull();
  });

  it('confirms the reuse on a followed route, first write or not', () => {
    const first = stepsFrom([
      { ...warm(1, 1, 0, 40_000, TURN_START), cache: { kind: 'cold', explained: false } },
      warm(1, 2, 40_000, 2_000, TURN_START + MINUTE),
    ]);
    expect(view({ steps: first }).group?.note).toBe('首次写入之后，每一步都复用了上一步的缓存。');
    const next = stepsFrom([
      { ...warm(1, 1, 0, 40_000, TURN_START), cache: { kind: 'cold', explained: false } },
      warm(1, 2, 40_000, 2_000, TURN_START + MINUTE),
      warm(2, 1, 42_000, 3_000, TURN_START + 2 * MINUTE),
      warm(2, 2, 45_000, 1_000, TURN_START + 3 * MINUTE),
    ]);
    const cache = view({ steps: next });
    expect(cache.group?.turn).toBe(2);
    expect(cache.group?.note).toBe('每一步都复用了上一步的缓存。');
  });
});

describe('deriveRunCacheView — long turns fold to the newest 20 rows', () => {
  it('shows the newest 20 and counts the rest behind 「查看更早的 N 步」', () => {
    const rows = buildCacheRows(issue9Steps());
    const folded = foldCacheRows(rows, false);
    expect(CACHE_ROWS_SHOWN).toBe(20);
    expect(folded.hidden).toBe(2);
    expect(folded.shown.map((row) => row.step)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 3)
    );
    expect(foldCacheRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(foldCacheRows(rows.slice(0, 20), false).hidden).toBe(0);
    expect(zh('Show {{count}} earlier steps', { count: 2 })).toBe('查看更早的 2 步');
  });
});

describe('deriveRunCacheView — the session alert', () => {
  /** One unexplained rebuild whose session totals are as given. */
  const withTotals = (rebuilds: number, rewrite: number, extra: Partial<StepSpec> = {}) =>
    stepsFrom([
      warm(1, 1, 0, 200_000, TURN_START),
      {
        turn: 1,
        step: 2,
        read: 30_000,
        write: 175_000,
        at: TURN_START + MINUTE,
        cache: {
          kind: 'rebuild',
          explained: false,
          lost: 170_002,
          rewrite,
          prevPrompt: 200_002,
          prefix: 'append',
          session: {
            unexplained: rebuilds,
            unexplainedLostTokens: rewrite,
            unexplainedRebuilds: rebuilds,
            unexplainedRewriteTokens: rewrite,
          },
        },
        ...extra,
      },
    ]);

  it('stays quiet for one unexplained rebuild that rewrote 60k', () => {
    expect(view({ steps: withTotals(1, 60_000) }).alert).toBeNull();
  });

  it('shows from two unexplained rebuilds, whatever they rewrote', () => {
    const alert = view({ steps: withTotals(2, 30_000) }).alert;
    expect(alert?.title).toBe('这个会话的缓存多次被重建');
    expect(alert?.body).toContain('有 2 次重建找不到本地原因，共重写约 30k tokens。');
  });

  it('shows for one unexplained rebuild that rewrote 120k, and says so in its title', () => {
    const alert = view({ steps: withTotals(1, 120_000) }, zh).alert;
    expect(alert?.title).toBe('这个会话的缓存被大段重建');
    expect(alert?.body).toContain('有 1 次重建找不到本地原因，共重写约 120k tokens。');
  });

  it('is gone for a chat whose alert was closed, and only for that chat', () => {
    const steps = withTotals(3, 300_000);
    expect(view({ steps, alertDismissed: true }).alert).toBeNull();
    expect(view({ steps, alertDismissed: false }).alert).not.toBeNull();
  });

  it('keeps the latest totals of the chat while the turn on screen has none', () => {
    const steps = [
      ...withTotals(2, 150_000),
      ...stepsFrom([warm(2, 1, 205_000, 1_000, TURN_START + 2 * MINUTE)]),
    ];
    const cache = view({ steps });
    expect(cache.group?.turn).toBe(2);
    expect(cache.group?.anomalies).toBe(0);
    expect(cache.alert?.title).toBe('这个会话的缓存多次被重建');
  });

  it('claims 「（已校验）」 only when every unexplained step the host counted was seen', () => {
    // The host counts 3, the renderer saw 1 (the others were before this run).
    const steps = stepsFrom([
      warm(1, 1, 0, 200_000, TURN_START),
      {
        turn: 1,
        step: 2,
        read: 30_000,
        write: 175_000,
        at: TURN_START + MINUTE,
        cache: {
          kind: 'rebuild',
          explained: false,
          rewrite: 170_002,
          prefix: 'append',
          session: { unexplained: 3, unexplainedRebuilds: 3, unexplainedRewriteTokens: 400_000 },
        },
      },
    ]);
    const cache = view({ steps });
    expect(cache.prefix).toBe('unknown');
    expect(cache.alert?.body).not.toContain('（已校验）');
  });

  it('renders in English from the source strings', () => {
    const alert = deriveRunCacheView(
      { steps: issue9Steps(), hasUnlistedHistory: false, alertDismissed: false },
      (key, params) => translate('en', key, params)
    ).alert;
    expect(alert?.title).toBe('This chat’s cache was rebuilt several times');
    expect(alert?.body).toBe(
      'Rebuilds with no local cause: 2, about 175k tokens written again. Each request extended the one before it (verified), so most likely the gateway sent them to different upstreams.'
    );
  });
});

describe('deriveRunCacheView — nothing listed', () => {
  it('says the steps before a reopen are not itemized (prototype state 4)', () => {
    const cache = view({ hasUnlistedHistory: true });
    expect(cache.group).toEqual({
      turn: null,
      rows: [],
      anomalies: 0,
      summary: '暂无明细',
      note: '重开之前的步骤不显示逐步明细。发出下一条消息后，这里会逐步列出。',
    });
    expect(cache.alert).toBeNull();
  });

  it('shows no group for a chat with nothing settled and no history', () => {
    expect(view().group).toBeNull();
    // Its first step running is not "history" either.
    expect(
      view({ steps: stepsFrom([{ ...warm(1, 1, 0, 40_000, TURN_START), pending: true }]) }).group
    ).toBeNull();
  });
});

describe('resolveCacheGroupOpen (issue #9 approval, item 5)', () => {
  it('opens on its own exactly when something is unexplained, until the user chooses', () => {
    expect(resolveCacheGroupOpen('auto', 0)).toBe(false);
    expect(resolveCacheGroupOpen('auto', 3)).toBe(true);
    expect(resolveCacheGroupOpen('open', 0)).toBe(true);
    expect(resolveCacheGroupOpen('closed', 3)).toBe(false);
  });
});

describe('cache figures', () => {
  it('rounds 「约」 figures to k / M and joins lists the locale’s way', () => {
    expect(formatApproxTokens(132_930)).toBe('133k');
    expect(formatApproxTokens(73_035)).toBe('73k');
    expect(formatApproxTokens(1_210_000)).toBe('1.21M');
    expect(formatApproxTokens(999_700)).toBe('1.00M');
    expect(formatApproxTokens(480)).toBe('480');
    expect(joinCacheList(['15', '17', '20'], zh)).toBe('15、17、20');
    expect(joinCacheList(['15', '17', '20'])).toBe('15, 17, 20');
    expect(issue9Specs()).toHaveLength(22);
  });
});
