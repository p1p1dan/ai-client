/**
 * dsh-rebase P1-12 step 2 — the runtime `bash` tool up to its approval, on
 * the pure library and the host's tree-sitter grammar.
 *
 * The 1.0.x tool did three things before it ran a command, and the DSH row
 * (`requestBuilder.ts`) does the same three: analyse the line and check every
 * operand it reaches against the deny list, written and canonical
 * (`checkShellPaths`); approve the call at the workspace (`authorizeTarget`);
 * analyse again and refuse if the operands moved during the approval. The
 * command itself never runs here: these suites pin verdicts.
 */

import { homedir } from 'node:os';
import { type BuiltGate, nodeFs } from '../../../shared/permissions/__tests__/gateHarness.ts';
import { analyzeBash, type BashAnalysis } from '../../../shared/permissions/bashWalker.ts';
import { createPermissionError } from '../../../shared/permissions/errors.ts';
import type { ToolPermissionRequest } from '../../../shared/permissions/gate.ts';
import { authorizeTarget, checkShellPaths } from '../../../shared/permissions/shellPaths.ts';
import { loadBashParser } from '../treeSitter.ts';

/** What the runtime handed its shell analysis: the host's child environment. */
export function shellEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: homedir(), ...extra };
}

/** One command line, analysed and checked against the deny list as written and canonical. */
export async function checkedAnalysis(
  built: BuiltGate,
  command: string,
  env: Record<string, string> = shellEnv()
): Promise<BashAnalysis> {
  const parser = await loadBashParser();
  return checkShellPaths(analyzeBash(parser, command, built.cwd, env), {
    fs: nodeFs,
    cwd: built.cwd,
  });
}

/**
 * One `bash` call up to the moment it would run. Resolves to the directory it
 * would run in; rejects with the code the runtime tool rejected with
 * (`tool_denied`, `invalid_tool_arguments`, `path_changed`).
 */
export async function bashCall(
  built: BuiltGate,
  command: string,
  options: { toolCallId?: string; env?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<string> {
  const env = options.env ?? shellEnv();
  const analysis = await checkedAnalysis(built, command, env);
  const cwd = await authorizeTarget(
    {
      fs: nodeFs,
      cwd: built.cwd,
      authorize: (request: ToolPermissionRequest, signal?: AbortSignal) =>
        built.gate.authorize(request, signal),
    },
    {
      tool: 'bash',
      toolCallId: options.toolCallId ?? 'shell',
      input: '.',
      command,
      shell: analysis,
      ...(options.signal ? { signal: options.signal } : {}),
    }
  );
  const current = await checkedAnalysis(built, command, env);
  if (JSON.stringify(current.paths) !== JSON.stringify(analysis.paths))
    throw createPermissionError('path_changed', 'shell paths changed during approval; retry');
  return cwd;
}
