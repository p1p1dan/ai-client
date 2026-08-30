import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  deriveAggregateRow,
  deriveToolRowView,
  formatToolArg,
  formatToolArgKind,
  PI_TOOL_NAMES,
  type ToolRun,
  toolVerb,
} from '../toolCard';

/**
 * T12-b — this file's tables have to speak pi's dialect, not Claude's.
 *
 * pi's built-in tools are lowercase (`read`, `edit`, `write`, `bash`, `grep`,
 * `find`, `ls`, `powershell`) and none of them collide with the capitalised
 * Claude names the tables were originally written for. Every lookup therefore
 * missed — silently, with no type error — and on the pi backend:
 *
 *   - every row read `Ran` (the unknown-tool fallback),
 *   - nothing classified as read/search, so tool AGGREGATION never fired,
 *   - `grep` displayed its `path` instead of its `pattern`, because the
 *     `default:` branch probes `path` before `pattern`,
 *   - paths rendered proportional instead of mono (`argKind` left undefined).
 *
 * Argument names are taken from the SDK's own schemas — pi says `path` where
 * Claude says `file_path`, so anything keyed on a field name must read both.
 */

function run(toolName: string, input: unknown, overrides: Partial<ToolRun> = {}): ToolRun {
  return {
    toolCallId: `call-${toolName}`,
    blockIndex: 0,
    blockId: `block-${toolName}`,
    toolName,
    input,
    status: 'ok',
    output: 'result',
    ...overrides,
  };
}

describe('pi built-in tools get real verbs', () => {
  it.each([
    [PI_TOOL_NAMES.read, 'Read', 'Reading'],
    [PI_TOOL_NAMES.edit, 'Edited', 'Editing'],
    [PI_TOOL_NAMES.write, 'Edited', 'Editing'],
    [PI_TOOL_NAMES.grep, 'Grepped', 'Grepping'],
    [PI_TOOL_NAMES.find, 'Searched files', 'Searching files'],
    [PI_TOOL_NAMES.ls, 'Listed', 'Listing'],
  ])('%s reads as "%s"', (tool, done, running) => {
    expect(toolVerb(tool, 'done')).toBe(done);
    expect(toolVerb(tool, 'running')).toBe(running);
  });

  it('leaves bash on Ran, which is correct rather than missing', () => {
    // Distinct from the others: `Ran` is the RIGHT verb for bash, and also the
    // unknown-tool fallback. Asserted so a future reader does not "fix" it.
    expect(toolVerb(PI_TOOL_NAMES.bash, 'done')).toBe('Ran');
    expect(toolVerb(PI_TOOL_NAMES.powershell, 'done')).toBe('Ran');
  });

  it('never leaves a pi built-in on the unknown-tool fallback', () => {
    // The blanket version of the above: whatever the verbs are, they must be
    // deliberate. Adding a pi tool to PI_TOOL_NAMES without a verb entry fails
    // here rather than shipping another silent `Ran`.
    for (const tool of Object.values(PI_TOOL_NAMES)) {
      const isShellTool = tool === PI_TOOL_NAMES.bash || tool === PI_TOOL_NAMES.powershell;
      if (isShellTool) continue;
      expect(toolVerb(tool, 'done')).not.toBe('Ran');
    }
  });
});

describe('pi built-in tools are classified for aggregation', () => {
  it.each([
    [PI_TOOL_NAMES.read, 'read'],
    [PI_TOOL_NAMES.grep, 'search'],
    [PI_TOOL_NAMES.find, 'search'],
    [PI_TOOL_NAMES.ls, 'search'],
    [PI_TOOL_NAMES.edit, 'action'],
    [PI_TOOL_NAMES.write, 'action'],
    [PI_TOOL_NAMES.bash, 'action'],
  ])('%s is a %s', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });

  it('dedupes read files by pi’s `path`, not only Claude’s `file_path`', () => {
    const entries = [
      { kind: 'run' as const, run: run(PI_TOOL_NAMES.read, { path: 'src/a.ts' }) },
      {
        kind: 'run' as const,
        run: run(PI_TOOL_NAMES.read, { path: 'src/a.ts' }, { toolCallId: 'call-2' }),
      },
    ];
    // Same file twice. Reading only `file_path` falls back to `toolCallId`,
    // which is unique per call, so this would say "2 files".
    expect(deriveAggregateRow(entries).arg).toBe('1 file');
  });
});

describe('pi tool arguments show the part that matters', () => {
  it('shows what grep searched for, not where', () => {
    // The regression this pins: `default:` probes `path` before `pattern`, so
    // this rendered "src".
    expect(formatToolArg(run(PI_TOOL_NAMES.grep, { pattern: 'TODO', path: 'src' }))).toBe('TODO');
  });

  it('names the repo when one is known', () => {
    expect(
      formatToolArg(run(PI_TOOL_NAMES.grep, { pattern: 'TODO' }), { repoName: 'ai-client' })
    ).toBe('TODO in ai-client');
  });

  it('renders read line ranges', () => {
    expect(
      formatToolArg(run(PI_TOOL_NAMES.read, { path: 'src/foo.ts', offset: 10, limit: 5 }))
    ).toBe('src/foo.ts L10-14');
  });

  it('says which directory an argument-less ls listed', () => {
    // `path` is optional in pi's schema; a bare `Listed` says nothing.
    expect(formatToolArg(run(PI_TOOL_NAMES.ls, {}))).toBe('working directory');
    expect(formatToolArgKind(run(PI_TOOL_NAMES.ls, {}))).toBe('prose');
  });

  it('marks paths and commands as identifiers so they render mono', () => {
    // D25 §2.4: `undefined` degrades to proportional, which is the safe
    // default but the wrong one for a path.
    expect(formatToolArgKind(run(PI_TOOL_NAMES.read, { path: 'src/foo.ts' }))).toBe('ident');
    expect(formatToolArgKind(run(PI_TOOL_NAMES.edit, { path: 'src/foo.ts' }))).toBe('ident');
    expect(formatToolArgKind(run(PI_TOOL_NAMES.write, { path: 'src/foo.ts' }))).toBe('ident');
    expect(formatToolArgKind(run(PI_TOOL_NAMES.bash, { command: 'npm test' }))).toBe('ident');
    expect(formatToolArgKind(run(PI_TOOL_NAMES.ls, { path: 'src' }))).toBe('ident');
  });

  it('shows the bash command', () => {
    expect(formatToolArg(run(PI_TOOL_NAMES.bash, { command: 'npm test' }))).toBe('npm test');
  });
});

describe('end to end on a row view', () => {
  it('renders an edit call as "Edited <path>"', () => {
    const view = deriveToolRowView(
      run(PI_TOOL_NAMES.edit, {
        path: 'src/foo.ts',
        edits: [{ oldText: 'a', newText: 'b' }],
      })
    );
    expect(view.verb).toBe('Edited');
    expect(view.arg).toBe('src/foo.ts');
    expect(view.argKind).toBe('ident');
  });
});
