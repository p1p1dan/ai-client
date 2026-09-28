/**
 * A fake DSH context for the aiclient-permissions row: listener lists with
 * Cordis' prepend semantics, waterfall dispatch, the guard stage exactly where
 * dsh-tools runs it (only after an `allow`), and `provide`.
 */

import type {
  DshAgentView,
  DshApprovalOutcome,
  DshApprovalRequest,
  DshPostToolDecision,
  DshPreToolDecision,
  DshToolCall,
  DshToolResult,
} from '../dshTypes.ts';
import type { PermissionRowContext } from '../plugin.ts';

type Listener = (...args: never[]) => unknown;
type AnyListener = (...args: unknown[]) => unknown;

export interface FakeDsh {
  ctx: PermissionRowContext;
  services: Map<string, unknown>;
  hooks(name: string): Array<{ listener: AnyListener; prepend: boolean }>;
  /** `tools/pre-execute` + guards, as dsh-tools' prepare stage runs them. */
  prepare(exec: DshToolCall): Promise<DshPreToolDecision>;
  postExecute(exec: DshToolCall, result: DshToolResult): Promise<DshPostToolDecision>;
  approval(request: DshApprovalRequest): Promise<DshApprovalOutcome>;
  emit(name: string, ...args: unknown[]): void;
  /** Register a listener as another row would (after the permission row). */
  on(name: string, listener: AnyListener, options?: { prepend?: boolean }): void;
}

export function createFakeDsh(): FakeDsh {
  const lists = new Map<string, Array<{ listener: AnyListener; prepend: boolean }>>();
  const guards: Array<(exec: object) => string | undefined> = [];
  const services = new Map<string, unknown>();
  const on = (name: string, listener: AnyListener, options?: { prepend?: boolean }) => {
    const list = lists.get(name) ?? [];
    const hook = { listener, prepend: options?.prepend === true };
    if (hook.prepend) list.unshift(hook);
    else list.push(hook);
    lists.set(name, list);
    return () => {
      const index = list.indexOf(hook);
      if (index >= 0) list.splice(index, 1);
      return index >= 0;
    };
  };
  const waterfall = <T>(name: string, args: unknown[], inner: () => Promise<T>): Promise<T> => {
    const callbacks = (lists.get(name) ?? []).map((hook) => hook.listener);
    const next = (): Promise<T> => {
      const callback = callbacks.shift();
      return callback ? (callback(...args, next) as Promise<T>) : inner();
    };
    return next();
  };
  const ctx: PermissionRowContext = {
    on: (name: string, listener: Listener, options?: { prepend?: boolean }) =>
      on(name, listener as unknown as AnyListener, options),
    tools: {
      guard: (guard) => {
        guards.push(guard);
        return () => {
          guards.splice(guards.indexOf(guard), 1);
        };
      },
    },
    provide: (name, value) => {
      if (services.has(name)) throw new Error(`service ${name} already provided`);
      services.set(name, value);
      return () => services.delete(name);
    },
  };
  return {
    ctx,
    services,
    hooks: (name) => lists.get(name) ?? [],
    async prepare(exec) {
      const decision = await waterfall<DshPreToolDecision>(
        'tools/pre-execute',
        [exec],
        async () => ({
          kind: 'allow',
        })
      );
      if (decision.kind !== 'allow') return decision;
      for (const guard of guards) {
        const reason = guard(exec);
        if (reason !== undefined) return { kind: 'deny', reason };
      }
      return decision;
    },
    postExecute: (exec, result) =>
      waterfall<DshPostToolDecision>('tools/post-execute', [exec, result], async () => ({
        kind: 'accept',
      })),
    approval: (request) =>
      waterfall<DshApprovalOutcome>('approval/request', [request], async () => 'unavailable'),
    emit(name, ...args) {
      for (const hook of lists.get(name) ?? []) hook.listener(...args);
    },
    on: (name, listener, options) => {
      on(name, listener, options);
    },
  };
}

let calls = 0;

/** An agent whose session header is `header` (cwd, lineage). */
export function agent(
  id: string,
  header: { cwd?: string; parentSession?: string; agentPreset?: string } = {}
): DshAgentView {
  return {
    id,
    session: {
      header: {
        id,
        ...header,
        ...(header.parentSession ? { origin: 'subagent' as const } : {}),
      },
    },
  };
}

/** One tool call as `tools/pre-execute` sees it. */
export function call(
  name: string,
  args: Record<string, unknown>,
  caller: DshAgentView | undefined,
  options: { callId?: string; signal?: AbortSignal; nested?: boolean } = {}
): DshToolCall {
  const callId = options.callId ?? `call-${++calls}`;
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: Object.freeze({ ...args }),
    ...(caller ? { agent: caller } : {}),
    ...(options.nested ? { parent: Symbol('parent') } : {}),
    signal: options.signal ?? new AbortController().signal,
  };
}
