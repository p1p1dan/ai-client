import type {
  SessionPermissionMode,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chatSessions';
import {
  type ContextGroupsInput,
  deriveContextGroups,
  deriveRunState,
  deriveSessionReferences,
  initialSessionRuntimeFacts,
  reduceSessionRuntimeFacts,
} from '../contextSurfaceModel';

// ---------------------------------------------------------------------------
// deriveContextGroups
// ---------------------------------------------------------------------------

const ALL_ROW_TEXT_FORBIDDEN = /\b(n\/a|unknown|placeholder|todo|lorem|example\.com)\b/i;

function baseInput(overrides: Partial<ContextGroupsInput> = {}): ContextGroupsInput {
  return {
    workspace: null,
    runtime: {
      configuredModel: null,
      actualModel: null,
      effortSelection: undefined,
      permissionMode: undefined,
      host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
    },
    session: null,
    ...overrides,
  };
}

describe('deriveContextGroups', () => {
  it('drops the Workspace and Session groups entirely with no session/workspace, keeping only Runtime (Host)', () => {
    const groups = deriveContextGroups(baseInput());
    expect(groups.map((g) => g.id)).toEqual(['runtime']);
    expect(groups[0].rows).toEqual([{ id: 'host-state', label: 'Host status', value: 'stopped' }]);
  });

  it('shows Host status even when stopped — a real value, not a placeholder (spec: "stopped 也照显")', () => {
    const groups = deriveContextGroups(baseInput());
    const runtime = groups.find((g) => g.id === 'runtime');
    const hostRow = runtime?.rows.find((r) => r.id === 'host-state');
    expect(hostRow?.value).toBe('stopped');
  });

  it('never fabricates a placeholder anywhere in the row values (reverse assertion, R6)', () => {
    const groups = deriveContextGroups(
      baseInput({
        workspace: { path: '/repo/app', kind: 'main', branch: null, gitEnabled: false },
        runtime: {
          configuredModel: 'sonnet',
          actualModel: null,
          effortSelection: null,
          permissionMode: null,
          host: { state: 'ready', pid: 123, driver: 'agent-sdk', version: '2.1.0' },
        },
        session: {
          status: 'idle',
          retryLabel: null,
          turnSendLabel: null,
          pendingPermissionsCount: 0,
          attachments: [],
          mentions: [],
          runtimeIdentity: null,
        },
      })
    );
    for (const group of groups) {
      for (const row of group.rows) {
        expect(row.value).not.toMatch(ALL_ROW_TEXT_FORBIDDEN);
      }
    }
  });

  describe('Workspace group', () => {
    it('renders path (with title + copyable) and kind, and drops the group when workspace is null', () => {
      const groups = deriveContextGroups(
        baseInput({
          workspace: { path: '/repo/app', kind: 'main', branch: null, gitEnabled: null },
        })
      );
      const workspace = groups.find((g) => g.id === 'workspace');
      expect(workspace?.rows).toEqual([
        { id: 'path', label: 'Path', value: '/repo/app', title: '/repo/app', copyable: true },
        { id: 'kind', label: 'Kind', value: 'main' },
      ]);
    });

    it('omits branch when missing, never falling back to a guessed name', () => {
      const groups = deriveContextGroups(
        baseInput({
          workspace: { path: '/repo/app', kind: 'worktree', branch: null, gitEnabled: true },
        })
      );
      const workspace = groups.find((g) => g.id === 'workspace');
      expect(workspace?.rows.some((r) => r.id === 'branch')).toBe(false);
    });

    it('omits branch when gitEnabled is not exactly true, even if a branch name is present', () => {
      for (const gitEnabled of [false, null, undefined] as const) {
        const groups = deriveContextGroups(
          baseInput({
            workspace: { path: '/repo/app', kind: 'main', branch: 'main', gitEnabled },
          })
        );
        const workspace = groups.find((g) => g.id === 'workspace');
        expect(workspace?.rows.some((r) => r.id === 'branch')).toBe(false);
      }
    });

    it('shows branch only when gitEnabled === true AND a branch is known', () => {
      const groups = deriveContextGroups(
        baseInput({
          workspace: { path: '/repo/app', kind: 'main', branch: 'feat/x', gitEnabled: true },
        })
      );
      const workspace = groups.find((g) => g.id === 'workspace');
      expect(workspace?.rows).toContainEqual({ id: 'branch', label: 'Branch', value: 'feat/x' });
    });
  });

  describe('Runtime group — model rows', () => {
    it('shows a single Model row when only configured is known', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: null,
            effortSelection: undefined,
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toContainEqual({ id: 'model', label: 'Model', value: 'sonnet' });
      expect(runtime?.rows.some((r) => r.id === 'model-actual')).toBe(false);
    });

    it('collapses to a single Model row when actual and configured agree', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: 'sonnet',
            effortSelection: undefined,
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows.filter((r) => r.id.startsWith('model'))).toEqual([
        { id: 'model', label: 'Model', value: 'sonnet' },
      ]);
    });

    it('shows both rows, source-annotated, only when actual and configured diverge (priority actual > configured)', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: 'claude-opus-4-8',
            effortSelection: undefined,
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toContainEqual({
        id: 'model-actual',
        label: 'Model (actual)',
        value: 'claude-opus-4-8',
      });
      expect(runtime?.rows).toContainEqual({
        id: 'model-configured',
        label: 'Model (configured)',
        value: 'sonnet',
      });
    });

    // A06 (config-model-impersonates-actual): the wiring contract this pure
    // layer depends on is that `actualModel` is ONLY ever fed from
    // `MessageMetadata.reportedModel` (see ContextSurfaceView.tsx), which
    // carries no fallback. This pins the honest consequence at the model-row
    // layer: with no report, there must be no "actual" row at all — never a
    // configured value re-labeled as if it were confirmed.
    it('never renders a "Model (actual)" row when actualModel is null (no report), regardless of a known configured model', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'claude-opus-4-8',
            actualModel: null,
            effortSelection: undefined,
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows.some((r) => r.id === 'model-actual')).toBe(false);
      expect(runtime?.rows).toContainEqual({
        id: 'model',
        label: 'Model',
        value: 'claude-opus-4-8',
      });
    });
  });

  describe('Runtime group — effort', () => {
    it('omits the row entirely when there is no session (undefined)', () => {
      const groups = deriveContextGroups(baseInput());
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows.some((r) => r.id === 'effort')).toBe(false);
    });

    it('shows "Default" for null — a real semantic, not a placeholder (spec §4)', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: null,
            effortSelection: null,
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toContainEqual({
        id: 'effort',
        label: 'Reasoning effort',
        value: 'Default',
      });
    });

    it('shows the catalog label for a known level', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: null,
            effortSelection: 'xhigh',
            permissionMode: undefined,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toContainEqual({
        id: 'effort',
        label: 'Reasoning effort',
        value: 'X-High',
      });
    });
  });

  describe('Runtime group — permission policy (R6:禁止写死 default)', () => {
    it('omits the row entirely when there is no session (undefined)', () => {
      const groups = deriveContextGroups(baseInput());
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows.some((r) => r.id === 'permission-policy')).toBe(false);
    });

    it('shows the honest "not reported" string for a session whose Host never reported one (null)', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: 'sonnet',
            actualModel: null,
            effortSelection: undefined,
            permissionMode: null,
            host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toContainEqual({
        id: 'permission-policy',
        label: 'Permission policy',
        value: 'Permission policy not reported',
      });
    });

    it('maps every known SessionPermissionMode to a distinct, non-default label', () => {
      const cases: Array<[SessionPermissionMode, string]> = [
        ['default', 'Default'],
        ['acceptEdits', 'Accept edits'],
        ['dontAsk', "Don't ask"],
        ['bypassPermissions', 'Bypass permissions'],
        ['plan', 'Plan'],
      ];
      for (const [mode, label] of cases) {
        const groups = deriveContextGroups(
          baseInput({
            runtime: {
              configuredModel: 'sonnet',
              actualModel: null,
              effortSelection: undefined,
              permissionMode: mode,
              host: { state: 'stopped', pid: undefined, driver: undefined, version: undefined },
            },
          })
        );
        const runtime = groups.find((g) => g.id === 'runtime');
        expect(runtime?.rows).toContainEqual({
          id: 'permission-policy',
          label: 'Permission policy',
          value: label,
        });
      }
    });
  });

  describe('Runtime group — Host rows', () => {
    it('shows pid/driver/version only when known', () => {
      const groups = deriveContextGroups(
        baseInput({
          runtime: {
            configuredModel: null,
            actualModel: null,
            effortSelection: undefined,
            permissionMode: undefined,
            host: { state: 'ready', pid: 4242, driver: 'agent-sdk', version: '2.1.0' },
          },
        })
      );
      const runtime = groups.find((g) => g.id === 'runtime');
      expect(runtime?.rows).toEqual([
        { id: 'host-state', label: 'Host status', value: 'ready' },
        { id: 'host-pid', label: 'Process ID', value: '4242' },
        { id: 'host-driver', label: 'Driver', value: 'agent-sdk' },
        { id: 'host-version', label: 'Version', value: '2.1.0' },
      ]);
    });
  });

  describe('Session group', () => {
    it('is dropped entirely when there is no session', () => {
      const groups = deriveContextGroups(baseInput());
      expect(groups.some((g) => g.id === 'session')).toBe(false);
    });

    it('shows status raw (verbatim, unmapped) and pendingPermissions even at 0 — a real count, not a fake state', () => {
      const groups = deriveContextGroups(
        baseInput({
          session: {
            status: 'waiting_permission',
            retryLabel: null,
            turnSendLabel: null,
            pendingPermissionsCount: 0,
            attachments: [],
            mentions: [],
            runtimeIdentity: null,
          },
        })
      );
      const session = groups.find((g) => g.id === 'session');
      expect(session?.rows).toEqual([
        { id: 'status', label: 'Status', value: 'waiting_permission' },
        { id: 'pending-permissions', label: 'Pending permissions', value: '0' },
      ]);
    });

    it('adds retry/turn rows only when present, and lists attachments/mentions/runtimeIdentity only when non-empty', () => {
      const groups = deriveContextGroups(
        baseInput({
          session: {
            status: 'running',
            retryLabel: 'Attempt 2/10 · retry in 500ms · unknown',
            turnSendLabel: 'awaiting · 3s',
            pendingPermissionsCount: 2,
            attachments: [{ kind: 'image', mediaType: 'image/png', name: 'shot.png' }],
            mentions: ['src/index.ts'],
            runtimeIdentity: 'rt-123',
          },
        })
      );
      const session = groups.find((g) => g.id === 'session');
      expect(session?.rows).toEqual([
        { id: 'status', label: 'Status', value: 'running' },
        { id: 'retry', label: 'Retry', value: 'Attempt 2/10 · retry in 500ms · unknown' },
        { id: 'turn', label: 'Turn', value: 'awaiting · 3s' },
        { id: 'pending-permissions', label: 'Pending permissions', value: '2' },
        { id: 'attachments', label: 'Sent attachments', value: 'image:shot.png' },
        { id: 'mentions', label: 'Mentions', value: 'src/index.ts' },
        {
          id: 'runtime-identity',
          label: 'Runtime identity',
          value: 'rt-123',
          title: 'rt-123',
        },
      ]);
    });

    it('flattens attachments without deduping and never shows raw data (structurally impossible: no `data` field)', () => {
      const groups = deriveContextGroups(
        baseInput({
          session: {
            status: 'idle',
            retryLabel: null,
            turnSendLabel: null,
            pendingPermissionsCount: 0,
            attachments: [
              { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
              { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
            ],
            mentions: [],
            runtimeIdentity: null,
          },
        })
      );
      const session = groups.find((g) => g.id === 'session');
      const attachmentsRow = session?.rows.find((r) => r.id === 'attachments');
      expect(attachmentsRow?.value).toBe('text:notes.txt, text:notes.txt');
    });
  });
});

// ---------------------------------------------------------------------------
// deriveRunState
// ---------------------------------------------------------------------------

const ALL_STATUSES: SessionRuntimeStatus[] = [
  'idle',
  'starting',
  'running',
  'waiting_permission',
  'waiting_question',
  'stopping',
  'completed',
  'failed',
  'disconnected',
];

describe('deriveRunState', () => {
  it('covers all 9 SessionRuntimeStatus values as a verbatim passthrough', () => {
    expect(ALL_STATUSES).toHaveLength(9);
    for (const status of ALL_STATUSES) {
      const view = deriveRunState({ status });
      expect(view.status).toBe(status);
      expect(view.retryLabel).toBeNull();
      expect(view.turnSendLabel).toBeNull();
    }
  });

  it('formats a retry detail line when present', () => {
    const retry: SessionRetryInfo = {
      attempt: 3,
      maxRetries: 10,
      delayMs: 1500,
      errorStatus: '503',
      error: 'unknown',
    };
    const view = deriveRunState({ status: 'running', retry });
    expect(view.retryLabel).toBe('Attempt 3/10 · retry in 1500ms · unknown 503');
  });

  it('formats a retry detail line without the errorStatus suffix when it is null', () => {
    const retry: SessionRetryInfo = {
      attempt: 1,
      maxRetries: 10,
      delayMs: 200,
      errorStatus: null,
      error: 'unknown',
    };
    const view = deriveRunState({ status: 'running', retry });
    expect(view.retryLabel).toBe('Attempt 1/10 · retry in 200ms · unknown');
  });

  it('formats a turnSend detail line when present', () => {
    const view = deriveRunState({
      status: 'running',
      turnSend: { phase: 'handshake', elapsedSeconds: 4 },
    });
    expect(view.turnSendLabel).toBe('handshake · 4s');
  });

  it('leaves both labels null when neither retry nor turnSend is supplied', () => {
    const view = deriveRunState({ status: 'idle' });
    expect(view.retryLabel).toBeNull();
    expect(view.turnSendLabel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveSessionReferences
// ---------------------------------------------------------------------------

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'user',
    blocks: [],
    ...overrides,
  };
}

describe('deriveSessionReferences', () => {
  it('counts only pending permissions for the given sessionId', () => {
    const result = deriveSessionReferences({
      sessionId: 's1',
      messages: [],
      pendingPermissions: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's1' }],
    });
    expect(result.pendingPermissionsCount).toBe(2);
  });

  it('flattens attachments across every user message, in order, without deduping', () => {
    const messages: ChatMessage[] = [
      userMessage({
        id: 'm1',
        attachments: [{ kind: 'image', mediaType: 'image/png', name: 'a.png' }],
        blocks: [],
      }),
      userMessage({
        id: 'm2',
        attachments: [{ kind: 'image', mediaType: 'image/png', name: 'a.png' }],
        blocks: [],
      }),
    ];
    const result = deriveSessionReferences({ sessionId: 's1', messages, pendingPermissions: [] });
    expect(result.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
    ]);
  });

  it('ignores assistant/system/error messages for both attachments and mentions', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        blocks: [{ id: 'b1', type: 'text', text: '@src/index.ts' }],
        attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'x.txt' }],
      },
    ];
    const result = deriveSessionReferences({ sessionId: 's1', messages, pendingPermissions: [] });
    expect(result.attachments).toEqual([]);
    expect(result.mentions).toEqual([]);
  });

  it('extracts @path mentions from user text blocks, separate from attachments', () => {
    const messages: ChatMessage[] = [
      userMessage({
        id: 'm1',
        blocks: [{ id: 'b1', type: 'text', text: 'please check @src/index.ts and @README.md' }],
      }),
    ];
    const result = deriveSessionReferences({ sessionId: 's1', messages, pendingPermissions: [] });
    expect(result.mentions).toEqual(['src/index.ts', 'README.md']);
    expect(result.attachments).toEqual([]);
  });

  it('returns empty lists and a zero count for a session with no messages/permissions', () => {
    const result = deriveSessionReferences({
      sessionId: 's1',
      messages: [],
      pendingPermissions: [],
    });
    expect(result).toEqual({ pendingPermissionsCount: 0, attachments: [], mentions: [] });
  });
});

// ---------------------------------------------------------------------------
// reduceSessionRuntimeFacts
// ---------------------------------------------------------------------------

describe('reduceSessionRuntimeFacts', () => {
  it('starts empty', () => {
    expect(initialSessionRuntimeFacts).toEqual({});
  });

  it('folds permissionMode from a session.created event', () => {
    const next = reduceSessionRuntimeFacts(initialSessionRuntimeFacts, {
      type: 'session.created',
      sessionId: 's1',
      payload: { permissionMode: 'acceptEdits' },
    });
    expect(next).toEqual({ s1: { permissionMode: 'acceptEdits' } });
  });

  it('folds permissionMode from a session.resumed event', () => {
    const next = reduceSessionRuntimeFacts(initialSessionRuntimeFacts, {
      type: 'session.resumed',
      sessionId: 's1',
      payload: { permissionMode: 'plan', runtimeIdentity: 'rt-1' },
    });
    expect(next).toEqual({ s1: { permissionMode: 'plan' } });
  });

  it('ignores every other event type', () => {
    const prev = { s1: { permissionMode: 'default' as const } };
    const next = reduceSessionRuntimeFacts(prev, {
      type: 'session.status',
      sessionId: 's1',
      payload: { permissionMode: 'bypassPermissions' },
    });
    expect(next).toBe(prev);
  });

  it('never overwrites a known value when a later event omits permissionMode', () => {
    const prev = { s1: { permissionMode: 'dontAsk' as const } };
    const next = reduceSessionRuntimeFacts(prev, {
      type: 'session.resumed',
      sessionId: 's1',
      payload: { runtimeIdentity: 'rt-2' },
    });
    expect(next).toBe(prev);
    expect(next.s1.permissionMode).toBe('dontAsk');
  });

  it('rejects an invalid/unknown permissionMode string instead of storing garbage', () => {
    const next = reduceSessionRuntimeFacts(initialSessionRuntimeFacts, {
      type: 'session.created',
      sessionId: 's1',
      payload: { permissionMode: 'yolo' },
    });
    expect(next).toEqual({});
  });

  it('isolates sessions — folding session A never touches session B', () => {
    const prev = reduceSessionRuntimeFacts(initialSessionRuntimeFacts, {
      type: 'session.created',
      sessionId: 'a',
      payload: { permissionMode: 'default' },
    });
    const next = reduceSessionRuntimeFacts(prev, {
      type: 'session.created',
      sessionId: 'b',
      payload: { permissionMode: 'bypassPermissions' },
    });
    expect(next).toEqual({
      a: { permissionMode: 'default' },
      b: { permissionMode: 'bypassPermissions' },
    });
  });

  it('is a no-op (returns the same reference) when an event carries no sessionId', () => {
    const prev = initialSessionRuntimeFacts;
    const next = reduceSessionRuntimeFacts(prev, {
      type: 'session.created',
      payload: { permissionMode: 'default' },
    });
    expect(next).toBe(prev);
  });
});
