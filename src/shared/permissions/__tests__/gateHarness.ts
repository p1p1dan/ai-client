/**
 * dsh-rebase P1-12 step 2 — the gate a 1.0.x runtime suite used to get from
 * `createRuntime`, built from the pure library alone.
 *
 * The runtime's bootstrap did four things for its permission service, and the
 * DSH bridge (`dshSessionRuntime.buildGate`) does the same four: the workspace
 * by its canonical spelling, programmatic scopes resolved against it, the
 * bundled policy plus whichever on-disk layers the setting sources open, and a
 * `PermissionGate` around them. A file tool reached the gate through
 * `authorizeTarget` (literal deny, canonical path, gate, re-check), and so do
 * the calls here. Nothing runs after an approval: these suites pin verdicts.
 */

import { opendir, readFile, realpath } from 'node:fs/promises';
import { resolveSettingSources } from '../../settingSources.ts';
import {
  type PermissionConfig,
  PermissionGate,
  type PermissionGateHooks,
  type ToolPermissionRequest,
} from '../gate.ts';
import { loadPermissionPolicy, type PermissionPolicyFiles } from '../policy.ts';
import { authorizeTarget, canonicalPath, type PermissionFileSystem } from '../shellPaths.ts';

/** The filesystem the DSH permission row hands the library (`permissionHost.ts`). */
export const nodeFs: PermissionFileSystem = {
  realpath: (path) => realpath(path),
  readDirectory: (path) =>
    (async function* () {
      yield* await opendir(path);
    })(),
};

/** Policy files read off disk; a missing one rejects with `ENOENT`, as the loader expects. */
export const policyFiles: PermissionPolicyFiles = {
  async readFile(path, { maxBytes }) {
    const bytes = await readFile(path);
    if (bytes.length > maxBytes)
      throw Object.assign(new Error(`read exceeds ${maxBytes} bytes: ${path}`), {
        code: 'io_limit',
      });
    return { bytes: new Uint8Array(bytes) };
  },
};

export type Approver = NonNullable<PermissionConfig['approve']>;

/** What a runtime suite passed as `permissions`, plus the `agentDir` it passed beside it. */
export interface GateOptions extends Omit<PermissionConfig, 'cwd' | 'policy'> {
  agentDir?: string;
}

export interface BuiltGate {
  gate: PermissionGate;
  /** The workspace by its canonical spelling, which every target resolves to. */
  cwd: string;
}

/** The gate `createRuntime` built for `tools: { cwd: workspace }` and these options. */
export async function buildGate(
  workspace: string,
  options: GateOptions = {},
  hooks: PermissionGateHooks = {}
): Promise<BuiltGate> {
  const { agentDir, scopes, ...config } = options;
  const cwd = await realpath(workspace);
  const resolvedScopes = await Promise.all(
    (scopes ?? []).map(async (scope) => ({
      ...scope,
      root: await canonicalPath(nodeFs, cwd, scope.root),
      tools: [...scope.tools],
    }))
  );
  const policy = await loadPermissionPolicy(policyFiles, {
    cwd,
    agentDir: agentDir ?? null,
    sources: resolveSettingSources({ projectTrusted: config.projectTrusted }),
  });
  return {
    gate: new PermissionGate({ ...config, cwd, scopes: resolvedScopes, policy }, hooks),
    cwd,
  };
}

/**
 * One file-tool call (`read`, `write`, `edit`, `glob`, `grep`) up to its
 * approval: what the runtime tool's `target()` did before opening the file.
 * Resolves to the canonical path the tool would open.
 */
export function fileCall(
  built: BuiltGate,
  tool: string,
  toolCallId: string,
  input: string,
  options: { signal?: AbortSignal; content?: string } = {}
): Promise<string> {
  return authorizeTarget(
    {
      fs: nodeFs,
      cwd: built.cwd,
      authorize: (request: ToolPermissionRequest, signal?: AbortSignal) =>
        built.gate.authorize(request, signal),
    },
    {
      tool,
      toolCallId,
      input,
      ...(options.signal ? { signal: options.signal } : {}),
      // `write` showed its content on the card, as the runtime tool did.
      ...(options.content !== undefined
        ? { preview: { label: 'Content', text: options.content } }
        : {}),
    }
  );
}

/** A gated call as a promise that reports rather than throws. */
export function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'allowed',
    (error: unknown) => (error as { code?: string }).code ?? 'failed'
  );
}
