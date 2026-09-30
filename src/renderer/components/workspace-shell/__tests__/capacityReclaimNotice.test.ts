// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e e3 (problem 11, decision 142): the pool's reclaim notice.
 *
 * The pool only reclaims a conversation Main sees as idle, so 「已停止运行」
 * was false for almost every one of them. It is kept for a conversation that
 * had a turn (a goal round, a job's wake-up) or a background job under way;
 * an idle one is told it moved to the background with nothing lost. And one
 * toast says the latest reclaim — each new chat past the pool's size reclaims
 * one, and the toasts used to pile up over the composer.
 */
import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

const probe = vi.hoisted(() => ({
  listener: undefined as undefined | ((event: RuntimeEvent) => void),
  added: [] as Array<{ id: string; title?: string; description?: string }>,
  closed: [] as string[],
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh, locale: 'zh' }) }));
vi.mock('@/stores/runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: RuntimeEvent) => void) => {
    probe.listener = listener;
    return () => {
      probe.listener = undefined;
    };
  },
}));
vi.mock('@/stores/chatSessions', () => ({
  useChatSessionsStore: {
    getState: () => ({
      sessions: [
        { id: 's1', title: '整理笔记' },
        { id: 's2', title: '跑测试' },
      ],
    }),
  },
}));
vi.mock('@/components/ui/toast', () => ({
  addToast: (options: { title?: string; description?: string }) => {
    const id = `toast-${probe.added.length + 1}`;
    probe.added.push({ id, ...options });
    return id;
  },
  toastManager: {
    close: (id: string) => {
      probe.closed.push(id);
    },
  },
}));

const { capacityReclaimCopy, noteSessionWork, useCapacityReclaimNotice } = await import(
  '../useCapacityReclaimNotice'
);

let seq = 0;
function event(sessionId: string, type: string, payload: unknown): RuntimeEvent {
  seq += 1;
  return { type, sessionId, seq, timestamp: seq, payload } as RuntimeEvent;
}
const reclaimed = (sessionId: string) =>
  event(sessionId, 'session.status', {
    status: 'disconnected',
    disconnectReason: 'capacity_reclaimed',
  });

describe('what a session had under way (P1-7e problem 11)', () => {
  it('[E3-11-WORK] busy statuses, a turn’s end, and running jobs; other events change nothing', () => {
    let work = noteSessionWork(new Map(), event('s1', 'session.status', { status: 'running' }));
    expect(work.get('s1')).toEqual({ turn: true, jobs: false });
    work = noteSessionWork(work, event('s1', 'session.completed', {}));
    expect(work.get('s1')).toEqual({ turn: false, jobs: false });
    work = noteSessionWork(
      work,
      event('s1', 'session.projection', {
        key: 'jobs',
        view: [{ id: 'bash-2', kind: 'bash', label: 'x', status: 'running', startedAt: 1 }],
      })
    );
    expect(work.get('s1')).toEqual({ turn: false, jobs: true });
    const same = noteSessionWork(work, event('s1', 'message.delta', { text: 'hi' }));
    expect(same).toBe(work);
    // P1-7e e6 (problem 39, decision 145): a disconnect is the worker going
    // away, and what it had under way goes with it.
    expect(noteSessionWork(work, reclaimed('s1')).get('s1')).toEqual({ turn: false, jobs: false });
  });

  it('[E3-11-COPY] 「已停止运行」 only for a session that was working', () => {
    const idle = capacityReclaimCopy({ name: '整理笔记', working: false }, zh);
    expect(idle.title).toBe('有一个对话已转入后台');
    expect(idle.description).toBe(
      '为了给新对话腾出位置，空闲的「整理笔记」已转入后台，内容都还在。点开它就能接着聊。'
    );
    expect(idle.description).not.toContain('停止');
    expect(capacityReclaimCopy({ working: false }, zh).description).toBe(
      '为了给新对话腾出位置，一个空闲的较早对话已转入后台，内容都还在。'
    );
    expect(capacityReclaimCopy({ name: '跑测试', working: true }, zh).description).toBe(
      '为了给新对话腾出位置，「跑测试」已停止运行。点开它就能继续。'
    );
  });
});

describe('the reclaim toast (P1-7e problem 11)', () => {
  let root: Root;
  let container: HTMLDivElement;

  function Hook() {
    useCapacityReclaimNotice();
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    probe.added.length = 0;
    probe.closed.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Hook)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('[E3-11-RECLAIM] words each reclaim by what the session was doing, and replaces the last toast', () => {
    const send = (e: RuntimeEvent) => probe.listener?.(e);
    send(event('s1', 'session.status', { status: 'idle' }));
    send(event('s2', 'session.status', { status: 'running' }));

    send(reclaimed('s1'));
    expect(probe.added).toHaveLength(1);
    expect(probe.added[0]?.description).toContain('空闲的「整理笔记」已转入后台');
    expect(probe.closed).toEqual([]);

    send(reclaimed('s2'));
    expect(probe.added).toHaveLength(2);
    expect(probe.added[1]?.description).toBe(
      '为了给新对话腾出位置，「跑测试」已停止运行。点开它就能继续。'
    );
    // One at a time: the first toast goes when the second comes.
    expect(probe.closed).toEqual(['toast-1']);
  });

  it('[E6-39] jobs the engine took down with it do not make a later reclaim say 「已停止运行」', () => {
    const send = (e: RuntimeEvent) => probe.listener?.(e);
    send(
      event('s1', 'session.projection', {
        key: 'jobs',
        view: [{ id: 'bash-1', kind: 'bash', label: 'ticker', status: 'running', startedAt: 1 }],
      })
    );
    // The host crashed: Main says `disconnected` (no reason) and reopens the
    // session; its jobs read 「引擎重启，任务已结束」. Minutes later the pool
    // reclaims it.
    send(event('s1', 'session.status', { status: 'disconnected' }));
    send(reclaimed('s1'));
    expect(probe.added.at(-1)?.description).toContain('空闲的「整理笔记」已转入后台');
    expect(probe.added.at(-1)?.description).not.toContain('已停止运行');
  });
});
