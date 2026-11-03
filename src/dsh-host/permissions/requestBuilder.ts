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
import {
  type ApprovalFileRead,
  approvalFileDiff,
  literalEditsOf,
} from '../../shared/permissions/approvalDiff.ts';
import {
  argumentsPreview,
  editArgumentsPreview,
} from '../../shared/permissions/approvalPreview.ts';
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
  hasParentSegment,
  type PermissionFileSystem,
} from '../../shared/permissions/shellPaths.ts';
import { classifyTool, type DshToolClass, pluginToolClass } from './classification.ts';
import { shellWorkdirTarget } from './shellWorkdir.ts';

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
  /**
   * The calling session's current directory (decision 207 §7): relative paths
   * resolve against it.
   */
  cwd: string;
  /**
   * The calling session's workspace (its header cwd), where a call that names
   * no path is judged (decision 207 §15). Absent: `cwd`.
   */
  workspace?: string;
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
  /**
   * Read a file as the fs tools see it (decrypted on the encrypted machine),
   * for an edit's or write's approval diff. Absent: the card shows arguments.
   */
  readFile?(path: string, cwd: string): Promise<ApprovalFileRead>;
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

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Decision 207 §15 (user, 2026-11-03): the directory a call moves the session,
 * or a delegate, into — `working_directory`'s `cd`, a subagent's `cwd`. DSH
 * then reads that project's AGENTS.md, CLAUDE.md and skills into the next
 * request, so a move out of the workspace asks first. Undefined: no move.
 */
export function directoryArgumentOf(name: string, args: unknown): string | undefined {
  if (name === 'working_directory') return stringArg(args, 'cd');
  if (name === 'subagent' || name === 'subagent_fork') return stringArg(args, 'cwd');
  return undefined;
}

function escalationOf(args: unknown): EscalationRequest | undefined {
  const mode = stringArg(args, 'sandbox_permissions');
  if (mode === undefined) return undefined;
  const justification = stringArg(args, 'justification');
  return { mode, ...(justification ? { justification } : {}) };
}

/**
 * Decision 190: the host a fetch would reach, lower case and without its
 * port, or undefined when `url` is not an absolute URL with one.
 */
export function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
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
  const directory = directoryArgumentOf(call.name, call.arguments);
  if (toolClass === 'internal' && directory === undefined) return { kind: 'internal' };
  const createError = context.createError ?? createPermissionError;
  const args = call.arguments;
  const escalation = escalationOf(args);
  // Only reads and searches may land on a host-produced file (a spill the model
  // was told to read); decided on the canonical path the path step hands over.
  const trustable = toolClass === 'read' || toolClass === 'search';
  // Every reading of the target must be one (decision 207 §15 item 7: a `..`
  // across a link adds the other reading to `paths`).
  const trusted = (request: ToolPermissionRequest) =>
    [request.path, ...(request.paths ?? [])].every((path) => context.isTrustedPath?.(path));
  const extra = (request: ToolPermissionRequest): ToolPermissionRequest => ({
    ...request,
    ...(trustable && trusted(request) ? { trustedPath: true } : {}),
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

  const workspace = context.workspace ?? context.cwd;
  if (directory !== undefined) {
    // Judged like a read of the directory: the user's `read` rules, no card
    // inside the workspace (see `ToolPermissionRequest.changeDirectory`).
    await target(call.name, directory, { policySurface: 'read', changeDirectory: true });
    return { kind: 'gated', toolClass };
  }

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
      // FR-05.5: an edit's card shows what it replaces with what, and whether
      // it replaces every match — not only the file name.
      const content = call.name === 'write' ? stringArg(args, 'content') : undefined;
      const preview =
        content !== undefined
          ? { label: 'Content', text: content }
          : typeof args === 'object' && args !== null
            ? { label: 'Arguments', text: editArgumentsPreview(args as Record<string, unknown>) }
            : undefined;
      const path = stringArg(args, 'file_path');
      // FR-05.5: the card shows the change against the file as it is now.
      const fileCall =
        content !== undefined
          ? { tool: 'write' as const, content }
          : (() => {
              const edits = literalEditsOf(args);
              return edits ? { tool: 'edit' as const, edits } : undefined;
            })();
      const fileDiff =
        path && fileCall && context.readFile
          ? approvalFileDiff(path, fileCall, await context.readFile(path, context.cwd))
          : undefined;
      await target(call.name, path ?? '.', {
        ...(preview ? { preview } : {}),
        ...(fileDiff ? { fileDiff } : {}),
      });
      break;
    }
    case 'shell': {
      const command = stringArg(args, 'command') ?? '';
      const given = stringArg(args, 'workdir');
      // Decision 207 §15 item 7: judged where DSH spawns it (`shellWorkdirTarget`):
      // its bash hands `<cwd>/<workdir>` to the system as written, which
      // resolves a link before the `..` after it; its pwsh folds the `..`
      // first. Only a `..` tells the two apart, so any other is folded as before.
      const workdir =
        given !== undefined && hasParentSegment(given)
          ? shellWorkdirTarget(call.name, given, context.cwd, context.platform ?? process.platform)
          : resolve(context.cwd, given ?? '.');
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
    case 'network': {
      // Decision 190: the subject is the host. Policy rules match it
      // (`"web_fetch": {"*.python.org": "allow"}`) and "Allow for session"
      // remembers it, so approving one page of a site does not approve every
      // site. A URL that does not parse is its own subject; the fetch refuses it.
      const url = stringArg(args, 'url') ?? '';
      // Decision 207 §15: no path, so judged at the workspace, wherever the session moved.
      await target(
        call.name,
        '.',
        {
          policySurface: call.name,
          policyValue: hostOf(url) ?? url,
          network: true,
          preview: { label: 'URL', text: url },
        },
        workspace
      );
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
      // Judged at the workspace like a fetch (decision 207 §15): an MCP call names no path.
      await target(
        call.name,
        '.',
        {
          policySurface: call.name,
          policyValue: call.name,
          preview: { label: 'Arguments', text: argumentsPreview(args) },
        },
        workspace
      );
  }
  return { kind: 'gated', toolClass, ...(escalation ? { escalation } : {}) };
}
