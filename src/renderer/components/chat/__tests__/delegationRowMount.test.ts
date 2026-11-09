// @vitest-environment happy-dom
/**
 * Decision 212 (user, 2026-11-09): in the timeline a subagent is one step
 * like the others — `● Explore(Map the calib code)` over one `⎿` line in the
 * terminal style, one line in the desktop style — with no icon and no list of
 * its own steps; a click opens its conversation. While it holds the turn it
 * carries the turn's status (decision 211).
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import type { SubagentLane } from '../subagentActivityModel';
import { ToolGroup } from '../ToolRows';
import { TranscriptStyleContext } from '../TranscriptBlocks';
import { deriveToolGroupRows, groupTimeline, type ToolRowView } from '../toolCard';
import { TurnLiveClockContext, TurnLiveSlotContext, turnLiveClockOf } from '../turnLiveStatus';
import { deriveStepRows } from '../turnSteps';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const LIVE = turnLiveClockOf(zh, { kind: 'tool', verb: 'Delegating' }, { minutes: 2, seconds: 3 });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToolExpansionStore.setState({ bySession: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSubagentActivityStore.setState({ lanes: {} });
  vi.unstubAllGlobals();
});

const CALL: ChatBlock = {
  id: 'c1',
  type: 'tool_call',
  toolCallId: 'c1',
  toolName: 'Agent',
  toolInput: { description: 'Map the calib code', prompt: 'Look around', subagent_type: 'Explore' },
};
const DONE: ChatBlock = {
  id: 'c1-r',
  type: 'tool_result',
  toolCallId: 'c1',
  toolOk: true,
  toolOutput: 'Found it.',
};

function lane(patch: Partial<SubagentLane> = {}): SubagentLane {
  return {
    parentToolCallId: 'c1',
    sessionId: 's',
    agentId: 'child-1',
    agentType: 'Explore',
    description: 'Map the calib code',
    status: 'running',
    taskType: null,
    startedAt: 1_000,
    endedAt: null,
    rows: [
      {
        kind: 'tool',
        toolCallId: 'r1',
        name: 'Read',
        input: { file_path: 'src/a.ts' },
        status: 'ok',
      },
      { kind: 'tool', toolCallId: 'r2', name: 'Bash', input: { command: 'ls' }, status: 'running' },
    ],
    droppedRows: 0,
    progress: null,
    usage: null,
    report: null,
    pendingPermission: null,
    capped: false,
    ordinal: 1,
    ...patch,
  };
}

function rowsOf(blocks: ChatBlock[], merge: 'adjacent' | 'stretch'): ToolRowView[] {
  const message: ChatMessage = { id: 'a', sessionId: 's', role: 'assistant', blocks };
  const group = groupTimeline(message).find((item) => item.kind === 'toolGroup');
  if (!group || group.kind !== 'toolGroup') throw new Error('no tool group');
  return deriveStepRows(deriveToolGroupRows(group.entries, { t: zh, thoughts: 'inPlace' }), zh, {
    merge,
  });
}

async function render(
  blocks: ChatBlock[],
  options: { style: 'terminal' | 'desktop'; laneState?: SubagentLane | null; slot?: boolean }
) {
  useSubagentActivityStore.setState({
    lanes: options.laneState === null ? {} : { c1: options.laneState ?? lane() },
  });
  const rows = rowsOf(blocks, options.style === 'terminal' ? 'adjacent' : 'stretch');
  await act(async () =>
    root.render(
      createElement(
        TranscriptStyleContext.Provider,
        { value: options.style },
        createElement(
          TurnLiveSlotContext.Provider,
          { value: options.slot ?? false },
          createElement(
            TurnLiveClockContext.Provider,
            { value: options.slot ? LIVE : null },
            createElement(ToolGroup, { rows, sessionId: 's' })
          )
        )
      )
    )
  );
}

const step = () => container.querySelector('[data-slot="delegation-step"]');

describe('[D212-TERM] terminal style: one step', () => {
  it('the type, what it was asked, and one ⎿ line of what it is doing', async () => {
    await render([CALL], { style: 'terminal' });
    const block = step()?.closest('[data-slot="terminal-block"]');
    expect(block?.textContent).toContain('Explore(Map the calib code)');
    expect(block?.textContent).toContain('⎿');
    expect(block?.textContent).toContain('Bash(ls) · 2 tool uses');
    // No icon, no list of its own steps.
    expect(block?.querySelector('svg')).toBeNull();
    expect(block?.textContent).not.toContain('Read(src/a.ts)');
    expect(container.querySelectorAll('[data-slot="terminal-block"]')).toHaveLength(1);
  });

  it('done: Done (…), and the line opens the conversation', async () => {
    await render([CALL, DONE], {
      style: 'terminal',
      laneState: lane({
        status: 'completed',
        endedAt: 64_000,
        report: { totalToolUseCount: 12, totalTokens: 45_200, totalDurationMs: 63_000 },
      }),
    });
    expect(step()?.textContent).toContain('Done (12 tool uses · 45.2k tokens · 1m 3s)');
    expect(step()?.querySelector('button')?.textContent).toContain('Explore(Map the calib code)');
    expect(step()?.getAttribute('data-tool-call-id')).toBe('c1');
  });

  it('nothing to open until the engine names the child', async () => {
    await render([CALL], { style: 'terminal', laneState: lane({ agentId: null }) });
    expect(step()?.querySelector('button')).toBeNull();
  });

  it('holding the turn, it carries the status: ✻ Explore(…) (2m 3s · esc 中断)', async () => {
    await render([CALL], { style: 'terminal', slot: true });
    expect(container.querySelector('[data-slot="turn-live-line"]')).toBeNull();
    const host = container.querySelector('[data-turn-live-host]');
    expect(host?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    expect(host?.querySelector('[data-slot="turn-live-tail"]')?.textContent).toBe(
      ' (2m 3s · esc 中断)'
    );
  });
});

describe('[D212-DESK] desktop style: one line between the runs', () => {
  it('its name and what it was asked, and a way into its conversation', async () => {
    await render([CALL, DONE], {
      style: 'desktop',
      laneState: lane({ status: 'completed', endedAt: 5_000, report: { totalToolUseCount: 2 } }),
    });
    const line = step();
    expect(line?.textContent).toContain('Explore Map the calib code');
    expect(line?.textContent).toContain('Done (2 tool uses');
    expect(line?.querySelector('button')).not.toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });

  it('holding the turn: the running icon, the words, the turn’s clock', async () => {
    await render([CALL], { style: 'desktop', slot: true });
    const host = container.querySelector('[data-turn-live-host]');
    expect(host?.getAttribute('data-slot')).toBe('delegation-step');
    expect(host?.querySelector('[data-status="running"]')).not.toBeNull();
    expect(host?.querySelector('[data-slot="turn-live-clock"]')?.textContent).toBe('2m 3s');
    expect(container.querySelector('[data-slot="turn-live-line"]')).toBeNull();
  });
});
