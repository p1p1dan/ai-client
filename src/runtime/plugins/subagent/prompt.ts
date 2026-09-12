/**
 * P5-2-2 — the delegate's system prompt.
 *
 * Provenance: `composeSubagentSystemPrompt` from PI-Desktop
 * `packages/agent-runtime/src/subagent.ts` at `948ee676`, plus the guidance
 * blocks its runtime supplied from `subagentGuidance`.
 *
 * The split is the reference's and is worth keeping: this module decides the
 * framing and the ordering, the caller supplies the session facts (shell,
 * scratch directory, project instructions) because it is the only thing that
 * knows them. The definition body sits ahead of the workspace guidance so a
 * project's own instructions still get the last word.
 *
 * The parent's collaboration rules are deliberately absent: a delegate has no
 * user to talk to, and its report format is set here.
 */

import {
  runtimeToolName,
  type SubagentDefinition,
  subagentCanMutate,
} from '../../../shared/subagentDefinition.ts';

export interface SubagentPromptInput {
  definition: SubagentDefinition;
  /** Tool names the delegate can actually call, in this runtime's spelling. */
  toolNames: readonly string[];
  /** Session facts inherited from the parent (shell dialect, scratch dir, rules). */
  guidance?: readonly string[];
}

export function composeSubagentSystemPrompt(input: SubagentPromptInput): string {
  const { definition } = input;
  // The names the model will see in its tool schemas, not the canonical
  // spelling the document uses: telling a delegate it has `Read` when the
  // schema says `read` is an invitation to call a tool that does not exist.
  const toolList = input.toolNames.join(', ') || 'none';
  const framing = [
    `You are the "${definition.name}" subagent, working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition)
      ? 'You may change files, but only the ones the task is about; leave everything else untouched.'
      : 'You have no tools that change files or run commands, so never report an edit you could not have made.',
    'Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.',
    'Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.',
  ].join('\n');
  return [framing, definition.prompt, ...(input.guidance ?? [])]
    .filter((block) => block.trim().length > 0)
    .join('\n\n');
}

/**
 * Session facts a delegate needs and cannot discover for itself.
 *
 * Provenance: `subagentGuidance` from the reference runtime, with the wording
 * re-fitted to our tools' actual parameters — telling a delegate to pass
 * `outputMode` or `headLimit` to a `grep` that has neither is worse than saying
 * nothing, because the delegate will spend a turn discovering the lie.
 *
 * Two of the reference's five blocks have no counterpart here and are absent
 * rather than faked:
 *
 * - **Shell dialect.** Our exec exit does not record a dialect the way the
 *   reference's `commandShell` does, so there is no fact to state.
 * - **Scratch directory.** This runtime has no session scratch root; the base
 *   prompt dropped that wording for the parent for the same reason
 *   (`prompt/baseSegments.ts`). A delegate told to write into `$PI_SCRATCH_DIR`
 *   would be told to write into a variable nothing sets.
 *
 * Both are recorded in `topics/p5-2-0-baseline.md` as differences rather than
 * gaps: there is nothing to port until the runtime grows the concept.
 */
export function subagentGuidance(input: {
  toolNames: readonly string[];
  /** The project's own instruction chain, when the session loaded one. */
  projectInstructions?: string;
}): string[] {
  const tools = new Set(input.toolNames);
  const blocks: string[] = [];
  if (tools.has('read') || tools.has('grep') || tools.has('glob')) {
    blocks.push(
      'Searching and reading: prefer read, grep and glob over shell text utilities. ' +
        'read accepts only an existing regular text file, never a directory; it takes ' +
        '`offset` (one-based line) and `limit`, and reports where to continue. ' +
        'grep takes a file-or-directory `path` plus `include`, `caseInsensitive` and `limit`; ' +
        'glob takes a directory `path`, a `pattern` and a `limit`. ' +
        'Scope every call, and use grep to locate content in a large file before reading a ' +
        'targeted range. Your context is finite too: an unscoped search over the whole ' +
        'workspace costs the tokens you need to finish.'
    );
  }
  if (tools.has('edit') || tools.has('write')) {
    blocks.push(
      'Editing: use edit for one small unique replacement and write for a coherent ' +
        'whole-file rewrite. Treat a failed edit as stale content — read the file once, ' +
        'regenerate the change, and if it fails again report the exact mismatch instead of ' +
        'looping. Never write a file the task did not ask you to change; another agent may ' +
        'be working in the same tree.'
    );
  }
  if (input.projectInstructions?.trim()) blocks.push(input.projectInstructions.trim());
  return blocks;
}

/**
 * Which of a definition's declared tools this runtime can actually supply.
 *
 * The intersection the P5-2 contract asks for: capability is
 * `definition.tools ∩ live registry`. A canonical name with no runtime
 * implementation (`BrowserPreview`, until P5-2-3) and a name whose tool is not
 * registered in this session (`bash` on a carrier without a shell) both drop
 * out here, which is why `Task` has to check for an empty result rather than
 * assuming a definition's tool list is available.
 */
export function resolveDelegateToolNames(
  definition: SubagentDefinition,
  registered: Iterable<string>
): { available: string[]; unavailable: string[] } {
  const live = new Set(registered);
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const canonical of definition.tools) {
    const name = runtimeToolName(canonical);
    if (name && live.has(name)) available.push(name);
    else unavailable.push(canonical);
  }
  return { available, unavailable };
}
