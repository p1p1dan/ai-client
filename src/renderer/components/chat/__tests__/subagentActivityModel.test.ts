import { describe, expect, it } from 'vitest';
import {
  derivePermissionOrigin,
  deriveSubagentPanelRows,
  initialSubagentActivity,
  reduceSubagentActivity,
  SUBAGENT_LANE_ROWS_MAX,
  SUBAGENT_LANES_MAX,
  SUBAGENT_PERMISSION_ORIGINS_MAX,
  type SubagentActivityState,
} from '../subagentActivityModel';

/**
 * T-34: the subagent panel's pure model — reducer invariants (isolation,
 * reference identity, the three caps, terminal no-downgrade), panel
 * derivation (liveness, collapse default, stats fallback chain, report
 * dedup) and the permission-origin chip. The store shell is covered in
 * `stores/__tests__/subagentActivity.test.ts`; the mount wiring in
 * `toolRowsWiring.test.ts`.
 */

const PARENT = 'toolu_parent_1';
const SESSION = 's1';

function activity(payload: Record<string, unknown>, sessionId = SESSION) {
  return {
    type: 'subagent.activity',
    sessionId,
    payload: { parentToolCallId: PARENT, ...payload },
  };
}

function fold(events: Array<Record<string, unknown>>, from = initialSubagentActivity) {
  return events.reduce<SubagentActivityState>(
    (state, event) => reduceSubagentActivity(state, event),
    from
  );
}

const started = (extra: Record<string, unknown> = {}) =>
  activity({
    kind: 'started',
    agentId: 'agent-1',
    agentType: 'general-purpose',
    description: 'shape probe',
    ...extra,
  });

describe('reduceSubagentActivity — carriers', () => {
  it('started creates a running lane with metadata and the agentId index', () => {
    const state = fold([started()]);
    const lane = state.lanes[PARENT];
    expect(lane.status).toBe('running');
    expect(lane.agentType).toBe('general-purpose');
    expect(lane.description).toBe('shape probe');
    expect(lane.sessionId).toBe(SESSION);
    expect(state.agentIndex['agent-1']).toBe(PARENT);
  });

  it('activity arriving before started builds a minimal carrier; started then fills metadata without wiping rows', () => {
    const early = fold([activity({ kind: 'text', id: 't1', text: 'hello' })]);
    expect(early.lanes[PARENT].rows).toHaveLength(1);
    expect(early.lanes[PARENT].status).toBeNull();

    const after = reduceSubagentActivity(early, started());
    expect(after.lanes[PARENT].rows).toHaveLength(1);
    expect(after.lanes[PARENT].agentType).toBe('general-purpose');
    expect(after.lanes[PARENT].status).toBe('running');
  });

  it('unrelated events return the SAME state reference', () => {
    const state = fold([started()]);
    for (const event of [
      { type: 'message.delta', sessionId: SESSION, payload: { text: 'x' } },
      { type: 'session.status', sessionId: SESSION, payload: { status: 'running' } },
      { type: 'tool.started', sessionId: SESSION, payload: { toolCallId: 'x', name: 'Read' } },
    ]) {
      expect(reduceSubagentActivity(state, event)).toBe(state);
    }
  });

  it('a payload without parentToolCallId (or kind, or sessionId) is a whole no-op', () => {
    const state = fold([started()]);
    expect(
      reduceSubagentActivity(state, {
        type: 'subagent.activity',
        sessionId: SESSION,
        payload: { kind: 'text', id: 't', text: 'x' },
      })
    ).toBe(state);
    expect(reduceSubagentActivity(state, activity({ kind: undefined }))).toBe(state);
    expect(
      reduceSubagentActivity(state, {
        type: 'subagent.activity',
        payload: { parentToolCallId: PARENT, kind: 'capped', limit: 200 },
      })
    ).toBe(state);
  });

  it('folding lane A never changes lane B’s reference (isolation)', () => {
    const twoLanes = fold([
      started(),
      activity({ kind: 'started', parentToolCallId: 'toolu_parent_2', agentId: 'agent-2' }),
    ]);
    const laneB = twoLanes.lanes.toolu_parent_2;
    const after = reduceSubagentActivity(twoLanes, activity({ kind: 'text', id: 't', text: 'x' }));
    expect(after.lanes.toolu_parent_2).toBe(laneB);
  });
});

describe('reduceSubagentActivity — rows', () => {
  it('tool.started appends a running row; tool.completed settles it in place (no second row)', () => {
    const state = fold([
      started(),
      activity({
        kind: 'tool.started',
        toolCallId: 'tc1',
        name: 'Read',
        input: { file_path: 'a' },
      }),
      activity({ kind: 'tool.completed', toolCallId: 'tc1', ok: true }),
    ]);
    expect(state.lanes[PARENT].rows).toEqual([
      { kind: 'tool', toolCallId: 'tc1', name: 'Read', input: { file_path: 'a' }, status: 'ok' },
    ]);
  });

  it('a failed completion carries errorText; a completion for an unseen id appends a settled row', () => {
    const state = fold([
      started(),
      activity({ kind: 'tool.completed', toolCallId: 'ghost', ok: false, errorText: 'boom' }),
    ]);
    expect(state.lanes[PARENT].rows).toEqual([
      { kind: 'tool', toolCallId: 'ghost', name: 'unknown', status: 'failed', errorText: 'boom' },
    ]);
  });

  it('text/thinking append rows; an empty or missing text body is dropped', () => {
    const state = fold([
      started(),
      activity({ kind: 'text', id: 't1', text: 'progress note' }),
      activity({ kind: 'thinking', id: 'th1', text: 'hmm' }),
      activity({ kind: 'thinking', id: 'th2', text: '' }),
      activity({ kind: 'text', id: 't2' }),
    ]);
    expect(state.lanes[PARENT].rows.map((r) => r.kind)).toEqual(['text', 'thinking']);
  });

  it('the row ring drops the oldest SETTLED row first and counts droppedRows; running tools survive', () => {
    const events: Array<Record<string, unknown>> = [
      started(),
      activity({ kind: 'tool.started', toolCallId: 'live', name: 'Bash' }),
    ];
    for (let i = 0; i < SUBAGENT_LANE_ROWS_MAX; i += 1) {
      events.push(activity({ kind: 'text', id: `t${i}`, text: `note ${i}` }));
    }
    const state = fold(events);
    const lane = state.lanes[PARENT];
    expect(lane.rows).toHaveLength(SUBAGENT_LANE_ROWS_MAX);
    expect(lane.droppedRows).toBe(1);
    // The running Bash row (oldest of all) kept its slot; text "note 0" went.
    expect(lane.rows[0]).toMatchObject({ kind: 'tool', toolCallId: 'live', status: 'running' });
    expect(lane.rows.some((r) => r.kind === 'text' && r.text === 'note 0')).toBe(false);
  });
});

describe('reduceSubagentActivity — progress / status / report', () => {
  it('progress replaces the snapshot (never appends) and merges usage field-wise', () => {
    const state = fold([
      started(),
      activity({
        kind: 'progress',
        description: 'Reading package.json',
        usage: { totalTokens: 100, toolUses: 1 },
      }),
      activity({ kind: 'progress', lastToolName: 'Bash', usage: { toolUses: 2 } }),
    ]);
    const lane = state.lanes[PARENT];
    expect(lane.rows).toHaveLength(0);
    expect(lane.progress).toEqual({ description: null, lastToolName: 'Bash' });
    // Second heartbeat had no totalTokens — the earlier count survives.
    expect(lane.usage).toEqual({ totalTokens: 100, toolUses: 2, durationMs: undefined });
  });

  it('a terminal failed is NOT downgraded by a later generic completed', () => {
    const state = fold([
      started(),
      activity({ kind: 'status', status: 'failed' }),
      activity({ kind: 'status', status: 'completed' }),
    ]);
    expect(state.lanes[PARENT].status).toBe('failed');
  });

  it('no terminal is resurrected by a straggling running heartbeat (Codex round 1 M3)', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      const state = fold([
        started(),
        activity({ kind: 'status', status: terminal }),
        activity({ kind: 'status', status: 'running' }),
      ]);
      expect(state.lanes[PARENT].status).toBe(terminal);
    }
  });

  it('report stores the structured summary, completes the lane and clears a pending permission', () => {
    const base = fold([started()]);
    const withPending: SubagentActivityState = {
      ...base,
      lanes: {
        ...base.lanes,
        [PARENT]: { ...base.lanes[PARENT], pendingPermission: { toolName: 'Bash' } },
      },
    };
    const state = reduceSubagentActivity(
      withPending,
      activity({
        kind: 'report',
        report: { status: 'completed', totalTokens: 26759, totalToolUseCount: 1 },
      })
    );
    const lane = state.lanes[PARENT];
    expect(lane.status).toBe('completed');
    expect(lane.report?.totalTokens).toBe(26759);
    expect(lane.pendingPermission).toBeNull();
  });

  it('a started racing in after a terminal does not resurrect the lane', () => {
    const state = fold([started(), activity({ kind: 'status', status: 'completed' }), started()]);
    expect(state.lanes[PARENT].status).toBe('completed');
  });

  it('a report status of cancelled or running is honored, not read as success (Codex round 1 m6)', () => {
    const cancelled = fold([
      started(),
      activity({ kind: 'report', report: { status: 'cancelled' } }),
    ]);
    expect(cancelled.lanes[PARENT].status).toBe('cancelled');
    // Async delegation: the report lands while the subagent still works —
    // the lane stays live instead of collapsing into a false "completed".
    const running = fold([started(), activity({ kind: 'report', report: { status: 'running' } })]);
    expect(running.lanes[PARENT].status).toBe('running');
  });

  it('duplicate deliveries are idempotent — no twin rows, no fresh reference (Codex round 1 m4)', () => {
    const base = fold([
      started(),
      activity({ kind: 'tool.started', toolCallId: 'tc', name: 'Read' }),
      activity({ kind: 'text', id: 't1', text: 'note' }),
    ]);
    expect(
      reduceSubagentActivity(
        base,
        activity({ kind: 'tool.started', toolCallId: 'tc', name: 'Read' })
      )
    ).toBe(base);
    expect(reduceSubagentActivity(base, activity({ kind: 'text', id: 't1', text: 'note' }))).toBe(
      base
    );
    // The single row still settles normally afterwards.
    const settled = reduceSubagentActivity(
      base,
      activity({ kind: 'tool.completed', toolCallId: 'tc', ok: true })
    );
    expect(settled.lanes[PARENT].rows.filter((r) => r.kind === 'tool')).toEqual([
      { kind: 'tool', toolCallId: 'tc', name: 'Read', status: 'ok' },
    ]);
  });
});

describe('reduceSubagentActivity — lane LRU', () => {
  it('the cap evicts the oldest non-running lane first and cleans its agentIndex entry', () => {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < SUBAGENT_LANES_MAX; i += 1) {
      events.push(activity({ kind: 'started', parentToolCallId: `lane-${i}`, agentId: `a-${i}` }));
    }
    // lane-0 stays running; lane-1 completes — lane-1 is the proper victim.
    events.push(activity({ kind: 'status', status: 'completed', parentToolCallId: 'lane-1' }));
    events.push(activity({ kind: 'started', parentToolCallId: 'lane-new', agentId: 'a-new' }));

    const state = fold(events);
    expect(Object.keys(state.lanes)).toHaveLength(SUBAGENT_LANES_MAX);
    expect(state.lanes['lane-1']).toBeUndefined();
    expect(state.lanes['lane-0']).toBeDefined();
    expect(state.lanes['lane-new']).toBeDefined();
    expect(state.agentIndex['a-1']).toBeUndefined();
  });
});

describe('reduceSubagentActivity — permissions', () => {
  const permissionRequested = (agentId?: string, permissionId = 'perm-1') => ({
    type: 'permission.requested',
    sessionId: SESSION,
    payload: { permissionId, toolName: 'Bash', ...(agentId ? { agentId } : {}) },
  });

  it('a subagent-tagged request parks on its lane and records the origin', () => {
    const state = fold([started(), permissionRequested('agent-1')]);
    expect(state.lanes[PARENT].pendingPermission).toEqual({ toolName: 'Bash' });
    expect(state.permissionOrigin['perm-1']).toEqual({
      parentToolCallId: PARENT,
      agentType: 'general-purpose',
      description: 'shape probe',
    });
  });

  it('a main-agent request (no agentId) returns the same reference', () => {
    const state = fold([started()]);
    expect(reduceSubagentActivity(state, permissionRequested(undefined))).toBe(state);
  });

  it('a request outrunning the lane still records a bare origin — the chip survives (Codex round 1 m5)', () => {
    const state = fold([permissionRequested('agent-early')]);
    expect(state.permissionOrigin['perm-1']).toEqual({
      parentToolCallId: null,
      agentType: null,
      description: null,
    });
    expect(Object.keys(state.lanes)).toHaveLength(0);
    expect(derivePermissionOrigin(state.permissionOrigin['perm-1'])).toEqual({
      label: 'From subagent',
    });
    // Resolve still cleans it up without a lane to touch.
    const resolved = reduceSubagentActivity(state, {
      type: 'permission.resolved',
      sessionId: SESSION,
      payload: { permissionId: 'perm-1' },
    });
    expect(resolved.permissionOrigin['perm-1']).toBeUndefined();
  });

  it('permission.resolved deletes the origin and clears the lane’s pending marker', () => {
    const state = fold([
      started(),
      permissionRequested('agent-1'),
      { type: 'permission.resolved', sessionId: SESSION, payload: { permissionId: 'perm-1' } },
    ]);
    expect(state.permissionOrigin['perm-1']).toBeUndefined();
    expect(state.lanes[PARENT].pendingPermission).toBeNull();
  });

  it('the origin map is bounded — the oldest entry is dropped past the cap', () => {
    const events: Array<Record<string, unknown>> = [started()];
    for (let i = 0; i <= SUBAGENT_PERMISSION_ORIGINS_MAX; i += 1) {
      events.push(permissionRequested('agent-1', `perm-${i}`));
    }
    const state = fold(events);
    expect(Object.keys(state.permissionOrigin)).toHaveLength(SUBAGENT_PERMISSION_ORIGINS_MAX);
    expect(state.permissionOrigin['perm-0']).toBeUndefined();
  });
});

describe('reduceSubagentActivity — session terminal sweep', () => {
  it('sweeps running and never-classified lanes of THAT session to cancelled', () => {
    const state = fold([
      started(),
      activity({ kind: 'text', id: 't', text: 'x', parentToolCallId: 'toolu_null_status' }),
      activity({ kind: 'started', parentToolCallId: 'toolu_other', agentId: 'a-o' }, 's2'),
      { type: 'session.stopped', sessionId: SESSION },
    ]);
    expect(state.lanes[PARENT].status).toBe('cancelled');
    expect(state.lanes.toolu_null_status.status).toBe('cancelled');
    expect(state.lanes.toolu_other.status).toBe('running');
  });

  it('a terminal for a session with nothing to sweep returns the same reference', () => {
    const state = fold([started(), activity({ kind: 'status', status: 'completed' })]);
    expect(reduceSubagentActivity(state, { type: 'session.failed', sessionId: SESSION })).toBe(
      state
    );
  });
});

// ---------------------------------------------------------------------------
// Panel derivation
// ---------------------------------------------------------------------------

describe('deriveSubagentPanelRows', () => {
  const lane = (events: Array<Record<string, unknown>>) => fold(events).lanes[PARENT];

  it('null and content-free lanes render nothing (no orphan border line)', () => {
    expect(deriveSubagentPanelRows(null, { parentRunning: true })).toEqual([]);
    const bare = lane([activity({ kind: 'text', id: 't', text: '' })]);
    expect(deriveSubagentPanelRows(bare, { parentRunning: true })).toEqual([]);
  });

  it('a live lane renders ONE header row, defaultOpen, with the children as detail', () => {
    const rows = deriveSubagentPanelRows(
      lane([started(), activity({ kind: 'tool.started', toolCallId: 'tc', name: 'Read' })]),
      { parentRunning: true }
    );
    expect(rows).toHaveLength(1);
    const header = rows[0];
    expect(header.verb).toBe('Subagent');
    expect(header.defaultOpen).toBe(true);
    expect(header.body).toBe('detail');
    expect(header.detail).toHaveLength(1);
    expect(header.detail?.[0].verb).toBe('Reading');
    // Registered deviation: the chevron must exist while live, so the header
    // is never a `running` row.
    expect(header.running).toBe(false);
  });

  it('an unclassified lane falls back to the parent row’s running state for liveness', () => {
    const l = lane([activity({ kind: 'text', id: 't', text: 'hello' })]);
    expect(deriveSubagentPanelRows(l, { parentRunning: true })[0].defaultOpen).toBe(true);
    expect(deriveSubagentPanelRows(l, { parentRunning: false })[0].defaultOpen).toBeUndefined();
  });

  it('live arg prefers progress.description, then lastToolName, then agentType', () => {
    const base = [started()];
    expect(deriveSubagentPanelRows(lane(base), { parentRunning: true })[0].arg).toBe(
      'general-purpose'
    );
    const withProgress = [
      ...base,
      activity({ kind: 'progress', description: 'Reading package.json', lastToolName: 'Read' }),
    ];
    expect(deriveSubagentPanelRows(lane(withProgress), { parentRunning: true })[0].arg).toBe(
      'Reading package.json'
    );
    const toolOnly = [...base, activity({ kind: 'progress', lastToolName: 'Read' })];
    expect(deriveSubagentPanelRows(lane(toolOnly), { parentRunning: true })[0].arg).toBe('Read');
  });

  it('a pending permission wins the header arg outright', () => {
    const state = fold([
      started(),
      {
        type: 'permission.requested',
        sessionId: SESSION,
        payload: { permissionId: 'p', toolName: 'Bash', agentId: 'agent-1' },
      },
    ]);
    const rows = deriveSubagentPanelRows(state.lanes[PARENT], { parentRunning: true });
    expect(rows[0].arg).toBe('Awaiting permission · Bash');
  });

  // chat-tool-05: both header branches printed the WIRE name, while the child
  // row one line below — built by `deriveToolRowView` — printed the label. An
  // MCP call therefore had two names on one screen, one of them a protocol
  // identifier. The existing cases used `Bash` / `Read`, where the two spellings
  // coincide, which is what hid it.
  it('names an MCP tool in the header the way the row below it does', () => {
    const running = fold([
      started(),
      activity({ kind: 'progress', lastToolName: 'mcp__github__create_issue' }),
    ]);
    expect(deriveSubagentPanelRows(running.lanes[PARENT], { parentRunning: true })[0].arg).toBe(
      'github · create_issue'
    );

    const gated = fold([
      started(),
      {
        type: 'permission.requested',
        sessionId: SESSION,
        payload: {
          permissionId: 'p',
          toolName: 'mcp__github__create_issue',
          agentId: 'agent-1',
        },
      },
    ]);
    expect(deriveSubagentPanelRows(gated.lanes[PARENT], { parentRunning: true })[0].arg).toBe(
      'Awaiting permission · github · create_issue'
    );
  });

  it('a completed lane summarizes from the report: type · tools · tokens · seconds', () => {
    const l = lane([
      started(),
      activity({
        kind: 'report',
        report: {
          status: 'completed',
          totalToolUseCount: 1,
          totalTokens: 26759,
          totalDurationMs: 12584,
        },
      }),
    ]);
    const header = deriveSubagentPanelRows(l, { parentRunning: false })[0];
    expect(header.arg).toBe('general-purpose · 1 tool · 26,759 tokens · 12.6s');
    expect(header.defaultOpen).toBeUndefined();
    expect(header.failed).toBe(false);
  });

  it('without a report the summary falls back to merged heartbeat usage, omitting missing segments', () => {
    const l = lane([
      started(),
      activity({ kind: 'progress', usage: { toolUses: 3 } }),
      activity({ kind: 'status', status: 'completed' }),
    ]);
    expect(deriveSubagentPanelRows(l, { parentRunning: false })[0].arg).toBe(
      'general-purpose · 3 tools'
    );
  });

  it('a failed lane leaves defaultOpen unset so the renderer’s failed fallback auto-opens it', () => {
    const l = lane([
      started(),
      activity({ kind: 'text', id: 't', text: 'x' }),
      activity({ kind: 'status', status: 'failed' }),
    ]);
    const header = deriveSubagentPanelRows(l, { parentRunning: false })[0];
    expect(header.failed).toBe(true);
    expect(header.defaultOpen).toBeUndefined();
  });

  it('keeps the delegate’s final answer when a report arrives', () => {
    // P5-2-6 reversed this case. It used to assert the LAST text row was
    // dropped, because under the T-34 host the delegation's own tool row
    // carried the subagent's answer as its output and the panel would have
    // shown it twice.
    //
    // The native runtime returns an ACK from `Task` and delivers the report
    // either through a later `TaskWait` or through an internal resume with no
    // bubble. Dropping the last text row therefore deleted the one copy the
    // user could see — "report once" had quietly become "report never".
    const l = lane([
      started(),
      activity({ kind: 'text', id: 't1', text: 'working on it' }),
      activity({ kind: 'tool.started', toolCallId: 'tc', name: 'Read' }),
      activity({ kind: 'text', id: 't2', text: 'final answer text' }),
      activity({ kind: 'report', report: { status: 'completed' } }),
    ]);
    const detail = deriveSubagentPanelRows(l, { parentRunning: false })[0].detail ?? [];
    expect(detail.map((r) => r.verb)).toEqual(['Said', 'Reading', 'Said']);
    expect(detail.at(-1)?.arg).toBe('final answer text');
  });

  it('text rows say Said, thinking rows say Thought; multi-line bodies expand to the full text', () => {
    const l = lane([
      started(),
      activity({ kind: 'text', id: 't', text: 'line one\nline two' }),
      activity({ kind: 'thinking', id: 'th', text: 'short' }),
    ]);
    const detail = deriveSubagentPanelRows(l, { parentRunning: true })[0].detail ?? [];
    expect(detail[0]).toMatchObject({
      verb: 'Said',
      arg: 'line one',
      expandable: true,
      body: 'thinking',
      output: 'line one\nline two',
    });
    expect(detail[1]).toMatchObject({ verb: 'Thought', arg: 'short', expandable: false });
  });

  it('failed child tools render through deriveToolRowView with the error as body', () => {
    const l = lane([
      started(),
      activity({ kind: 'tool.started', toolCallId: 'tc', name: 'Bash', input: { command: 'x' } }),
      activity({ kind: 'tool.completed', toolCallId: 'tc', ok: false, errorText: 'exit 1' }),
    ]);
    const detail = deriveSubagentPanelRows(l, { parentRunning: true })[0].detail ?? [];
    expect(detail[0]).toMatchObject({ verb: 'Ran', failed: true, output: 'exit 1' });
  });

  it('droppedRows and the cap marker surface honestly', () => {
    const events: Array<Record<string, unknown>> = [started()];
    for (let i = 0; i <= SUBAGENT_LANE_ROWS_MAX; i += 1) {
      events.push(activity({ kind: 'text', id: `t${i}`, text: `n${i}` }));
    }
    events.push(activity({ kind: 'capped', limit: 200 }));
    const header = deriveSubagentPanelRows(lane(events), { parentRunning: true })[0];
    expect(header.arg).toBe('general-purpose · +1 earlier');
    const last = header.detail?.[header.detail.length - 1];
    expect(last).toMatchObject({
      verb: 'Capped',
      arg: 'activity feed capped — remaining live updates dropped',
    });
  });
});

describe('derivePermissionOrigin', () => {
  it('null in, null out', () => {
    expect(derivePermissionOrigin(null)).toBeNull();
    expect(derivePermissionOrigin(undefined)).toBeNull();
  });

  it('prefers the task description, falls back to agent type, then to the bare label', () => {
    expect(
      derivePermissionOrigin({
        parentToolCallId: PARENT,
        agentType: 'general-purpose',
        description: 'shape probe',
      })
    ).toEqual({ label: 'From subagent · shape probe' });
    expect(
      derivePermissionOrigin({
        parentToolCallId: PARENT,
        agentType: 'general-purpose',
        description: null,
      })
    ).toEqual({ label: 'From subagent · general-purpose' });
    expect(
      derivePermissionOrigin({ parentToolCallId: PARENT, agentType: null, description: null })
    ).toEqual({ label: 'From subagent' });
  });
});

/**
 * P5-2-6: a reopened session has no live activity to fold — the conversation
 * already happened. The delegation summaries come off the session file on the
 * history read, and these cases pin that the panels come back with the state
 * that was recorded rather than with a spinner or with nothing.
 */
describe('reduceSubagentActivity — history rebuild', () => {
  const history = (subagents: unknown[], sessionId = SESSION) => ({
    type: 'session.history',
    sessionId,
    payload: { messages: [], truncated: false, omittedCount: 0, subagents },
  });

  const summary = (extra: Record<string, unknown> = {}) => ({
    delegationId: 'd1',
    parentToolCallId: PARENT,
    agentName: 'explorer',
    label: 'survey the repo',
    status: 'completed',
    startedAt: 1_000,
    completedAt: 4_000,
    turns: 4,
    toolCalls: 7,
    totalTokens: 30,
    report: 'Found three config files.',
    model: 'anthropic/claude-sonnet-5',
    ...extra,
  });

  it('rebuilds a finished delegation with its report, counters and duration', () => {
    const lane = fold([history([summary()])]).lanes[PARENT];
    expect(lane).toMatchObject({
      status: 'completed',
      agentId: 'd1',
      agentType: 'explorer',
      description: 'survey the repo',
      sessionId: SESSION,
    });
    expect(lane.rows).toEqual([
      { kind: 'text', id: `history-${PARENT}`, text: 'Found three config files.' },
    ]);
    expect(lane.usage).toEqual({ totalTokens: 30, toolUses: 7, durationMs: 3_000 });
    expect(lane.report).toMatchObject({
      totalToolUseCount: 7,
      resolvedModel: 'anthropic/claude-sonnet-5',
    });
  });

  it('renders the rebuilt lane as a finished panel, report and all', () => {
    const lane = fold([history([summary()])]).lanes[PARENT];
    const rows = deriveSubagentPanelRows(lane, { parentRunning: false });
    expect(rows[0].detail?.[0]).toMatchObject({ verb: 'Said', arg: 'Found three config files.' });
    // The finished-run stats line, not the live one.
    expect(rows[0].arg).toContain('explorer');
    expect(rows[0].arg).toContain('7 tools');
  });

  it('shows a delegation that never settled as cancelled, never as running', () => {
    // A hard exit records a start with no settlement. Showing it as running
    // would be a reopened session claiming work is still in flight.
    const lane = fold([history([summary({ status: 'interrupted', completedAt: undefined })])])
      .lanes[PARENT];
    expect(lane.status).toBe('cancelled');
  });

  it('maps a recorded timeout onto a failure rather than dropping it', () => {
    expect(fold([history([summary({ status: 'timed_out' })])]).lanes[PARENT].status).toBe('failed');
  });

  it('keeps stopped and truncated distinct, as the wire type widened for', () => {
    expect(fold([history([summary({ status: 'stopped' })])]).lanes[PARENT].status).toBe('stopped');
    expect(fold([history([summary({ status: 'truncated' })])]).lanes[PARENT].status).toBe(
      'truncated'
    );
  });

  it('never overwrites a live lane with a history snapshot', () => {
    // A refresh can land while a delegation is running; the live lane is the
    // one with the truth in it.
    const state = fold([
      started(),
      activity({ kind: 'text', id: 't1', text: 'working' }),
      history([summary()]),
    ]);
    expect(state.lanes[PARENT].status).toBe('running');
    expect(state.lanes[PARENT].rows).toHaveLength(1);
    expect(state.lanes[PARENT].rows[0]).toMatchObject({ text: 'working' });
  });

  it('ignores a history read that carries no delegations at all', () => {
    const before = fold([started()]);
    expect(reduceSubagentActivity(before, history([]))).toBe(before);
    expect(
      reduceSubagentActivity(before, {
        type: 'session.history',
        sessionId: SESSION,
        payload: { messages: [], truncated: false, omittedCount: 0 },
      })
    ).toBe(before);
  });

  it('rebuilds the most recent delegations when there are more than the lane budget', () => {
    const many = Array.from({ length: SUBAGENT_LANES_MAX + 5 }, (_, index) =>
      summary({ delegationId: `d${index}`, parentToolCallId: `toolu_${index}` })
    );
    const state = fold([history(many)]);
    expect(Object.keys(state.lanes)).toHaveLength(SUBAGENT_LANES_MAX);
    // The tail wins the budget: those are the ones near where the user is
    // reading, and taking the head would rebuild the oldest instead.
    expect(state.lanes.toolu_4).toBeUndefined();
    expect(state.lanes[`toolu_${SUBAGENT_LANES_MAX + 4}`]).toBeDefined();
  });

  it('indexes the rebuilt delegation so a later permission can still find it', () => {
    const state = fold([history([summary()])]);
    expect(state.agentIndex.d1).toBe(PARENT);
  });
});

/**
 * P5-2-6: the native runtime knows which delegate is at the gate, so the card
 * can name it. Before this the payload carried neither id nor name, and a
 * delegate's approval request was indistinguishable from the main agent's.
 */
describe('derivePermissionOrigin — the delegate’s name', () => {
  it('names the subagent from the request itself, before its lane exists', () => {
    const state = reduceSubagentActivity(initialSubagentActivity, {
      type: 'permission.requested',
      sessionId: SESSION,
      payload: {
        permissionId: 'p1',
        toolName: 'bash',
        agentId: 'agent-1',
        agentName: 'test-runner',
      },
    });
    // No lane yet — the gate outran `started`. The chip must still say which
    // delegate is asking, which is the whole point of carrying the name.
    expect(derivePermissionOrigin(state.permissionOrigin.p1)).toEqual({
      label: 'From subagent · test-runner',
    });
  });

  it('prefers the lane’s description once there is one', () => {
    const state = fold([
      started(),
      {
        type: 'permission.requested',
        sessionId: SESSION,
        payload: {
          permissionId: 'p1',
          toolName: 'bash',
          agentId: 'agent-1',
          agentName: 'test-runner',
        },
      },
    ]);
    expect(derivePermissionOrigin(state.permissionOrigin.p1)?.label).toContain('shape probe');
    // And the lane itself shows it is waiting.
    expect(state.lanes[PARENT].pendingPermission).toEqual({ toolName: 'bash' });
  });
});
