/**
 * One DSH tool call -> one decision of the shared permission gate (dsh-rebase
 * P1-6b; design shard 03 §2-§3).
 *
 * The call is mapped onto the `ToolPermissionRequest` the 1.0.x tools built for
 * the same kind of operation, then judged by the pure library's own three
 * steps (`authorizeTarget`): literal deny on the spelling the model wrote,
 * canonical resolution, the gate, and a second canonical read once the gate
 * answers. A shell call's operands are expanded and checked the same way
 * before and after the approval.
 */

import { resolve } from 'node:path';
import type { BashAnalysis } from '../../shared/permissions/bashWalker.ts';
import {
  createPermissionError,
  type PermissionErrorFactory,
} from '../../shared/permissions/errors.ts';
import type {
  PermissionGateService,
  ToolPermissionRequest,
} from '../../shared/permissions/gate.ts';
import { analyzePwsh, PWSH_TOOL } from '../../shared/permissions/pwshAnalysis.ts';
import {
  authorizeTarget,
  checkShellPaths,
  type PermissionFileSystem,
} from '../../shared/permissions/shellPaths.ts';
import { classifyTool, type DshToolClass, pluginToolClass } from './classification.ts';

/** The part of a DSH call the mapping reads. */
export interface GatedCallInput {
  readonly name: string;
  readonly callId: string;
  readonly arguments: unknown;
  readonly signal?: AbortSignal;
}

/** Everything a call is judged against, resolved for the calling agent. */
export interface GateCallContext {
  gate: Pick<PermissionGateService, 'authorize'>;
  /** The calling session's workspace (its header cwd). */
  cwd: string;
  fs: PermissionFileSystem;
  /** Analyse one bash command line (tree-sitter), relative to `cwd`. */
  analyzeBash(command: string, cwd: string): Promise<BashAnalysis>;
  /**
   * What `$env:NAME` and `$HOME` expand to in a `pwsh` command (P1-6d); the
   * host's own environment. Absent: every variable is unresolved.
   */
  env?: Record<string, string>;
  /** Whose path rules a `pwsh` command is read under; defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Paths the host produced itself (spill files): no workspace-boundary ask. */
  isTrustedPath?(path: string): boolean;
  /** Set when a delegate made the call: the card and audit row name it. */
  delegation?: { delegationId: string; agentName: string };
  createError?: PermissionErrorFactory;
}

/** A sandbox escalation the call asked for in its own arguments. */
export interface EscalationRequest {
  mode: string;
  justification?: string;
}

export type GatedCall =
  | { kind: 'internal' }
  | { kind: 'gated'; toolClass: DshToolClass | 'unknown'; escalation?: EscalationRequest };

const PREVIEW_MAX_CHARS = 4000;

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function escalationOf(args: unknown): EscalationRequest | undefined {
  const mode = stringArg(args, 'sandbox_permissions');
  if (mode === undefined) return undefined;
  const justification = stringArg(args, 'justification');
  return { mode, ...(justification ? { justification } : {}) };
}

function argumentsPreview(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? '';
  } catch {
    text = String(args);
  }
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

/**
 * Judge one call. Resolves when the gate allowed it; rejects with the gate's
 * refusal (`denialSource` tells why), an abort of `call.signal`, or a coded
 * error (`path_changed`, `invalid_tool_arguments`, `shell_path_limit`,
 * `tool_denied` for a literal deny) otherwise.
 */
export async function authorizeCall(
  call: GatedCallInput,
  context: GateCallContext
): Promise<GatedCall> {
  const toolClass = classifyTool(call.name);
  if (toolClass === 'internal') return { kind: 'internal' };
  const createError = context.createError ?? createPermissionError;
  const args = call.arguments;
  const escalation = escalationOf(args);
  // Only reads and searches may land on a host-produced file (a spill the model
  // was told to read); decided on the canonical path the path step hands over.
  const trustable = toolClass === 'read' || toolClass === 'search';
  const extra = (request: ToolPermissionRequest): ToolPermissionRequest => ({
    ...request,
    ...(trustable && context.isTrustedPath?.(request.path) ? { trustedPath: true } : {}),
    ...(context.delegation ? { delegation: context.delegation } : {}),
  });
  const target = (
    tool: string,
    input: string,
    fields: Partial<ToolPermissionRequest> & { shell?: BashAnalysis; command?: string } = {},
    cwd = context.cwd
  ) => {
    const { shell, command, preview, ...rest } = fields;
    return authorizeTarget(
      {
        fs: context.fs,
        cwd,
        createError,
        authorize: (request, signal) =>
          context.gate.authorize(extra({ ...request, ...rest }), signal),
      },
      {
        tool,
        toolCallId: call.callId,
        input,
        signal: call.signal,
        ...(command !== undefined ? { command } : {}),
        ...(shell ? { shell } : {}),
        ...(preview ? { preview } : {}),
      }
    );
  };

  // P1-10d: an allowlisted plugin's read or write names its file in its own argument.
  const plugin = pluginToolClass(call.name);
  switch (toolClass) {
    case 'read':
      await target('read', stringArg(args, plugin?.path ?? 'file_path') ?? '.');
      break;
    case 'search':
      await target(call.name, stringArg(args, 'path') ?? '.');
      break;
    case 'write': {
      if (plugin) {
        // The card names the plugin's own tool and shows its arguments (the
        // content it writes); `write` path rules apply to it, and accept-edits
        // allows it inside the workspace as it does write / edit.
        await target(call.name, stringArg(args, plugin.path) ?? '.', {
          policySurface: 'write',
          fileWrite: true,
          preview: { label: 'Arguments', text: argumentsPreview(args) },
        });
        break;
      }
      const content = call.name === 'write' ? stringArg(args, 'content') : undefined;
      await target(
        call.name,
        stringArg(args, 'file_path') ?? '.',
        content !== undefined ? { preview: { label: 'Content', text: content } } : {}
      );
      break;
    }
    case 'shell': {
      const command = stringArg(args, 'command') ?? '';
      const workdir = resolve(context.cwd, stringArg(args, 'workdir') ?? '.');
      // Both shells: operands expanded and checked against the deny list,
      // before the approval and again after it. The policy surface is `bash`
      // for either (the gate's default for a shell tool).
      const analyse = async () =>
        checkShellPaths(
          call.name === PWSH_TOOL
            ? analyzePwsh(command, workdir, context.env ?? {}, {
                createError,
                ...(context.platform ? { platform: context.platform } : {}),
              })
            : await context.analyzeBash(command, workdir),
          { fs: context.fs, cwd: workdir, createError }
        );
      const analysis = await analyse();
      await target(call.name, workdir, { command, shell: analysis }, workdir);
      const current = await analyse();
      if (JSON.stringify(current.paths) !== JSON.stringify(analysis.paths))
        throw createError('path_changed', 'shell paths changed during approval; retry');
      break;
    }
    case 'skill': {
      const name = stringArg(args, 'name') ?? '';
      await target('skill', '.', { policySurface: 'skill', policyValue: name, trustedPath: true });
      break;
    }
    case 'opaque': {
      const program = stringArg(args, 'code') ?? stringArg(args, 'script');
      await target(call.name, '.', {
        policySurface: call.name,
        policyValue: call.name,
        unresolvedPaths: true,
        preview:
          program !== undefined
            ? { label: 'Program', text: program }
            : { label: 'Arguments', text: argumentsPreview(args) },
      });
      break;
    }
    default:
      // generic and unknown (unclassified plugin) tools: the policy's per-tool rule, `'*': 'ask'`.
      await target(call.name, '.', {
        policySurface: call.name,
        policyValue: call.name,
        preview: { label: 'Arguments', text: argumentsPreview(args) },
      });
  }
  return { kind: 'gated', toolClass, ...(escalation ? { escalation } : {}) };
}
