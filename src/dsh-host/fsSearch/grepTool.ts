/**
 * Registers decision 190's `grep` (the rules are `grep.ts`) and runs ripgrep
 * for it through `ctx.subprocess`, the way dsh-tool-fs-search's own grep
 * does: the packaged binary (`resolveRgPath`), `--no-config` first so no
 * ripgrep config file can inject `--pre`, one argv vector and no shell, the
 * cooperative timeout through `exec.signal`, and the same `SEARCH_*` error
 * codes. Two things differ: an exit-2 run that still printed results returns
 * them with ripgrep's complaints as a note (DSH's fails the whole search over
 * one unreadable directory), and `files_with_matches` is ordered by
 * modification time, which takes one `stat` per listed file.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GLOB_VCS_EXCLUDES,
  resolveRgPath,
  SearchError,
  toWorkdirRelative,
} from '@deepseek-ai/dsh-tool-fs-search';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  buildGrepArgv,
  comparePaths,
  GREP_PARAMETERS,
  GREP_TOOL_DESCRIPTION,
  GREP_TOOL_GUIDANCE,
  GREP_VALUE_SCHEMA,
  type GrepArgs,
  type GrepEntry,
  type GrepInput,
  GrepOutputError,
  type GrepValue,
  orderByRecency,
  orderContent,
  parseContentOutput,
  parseCountOutput,
  parseFilesOutput,
  parseGrepArgs,
  presentGrepCall,
  renderGrep,
  unreadablePathNotes,
} from './grep.ts';

/** The deployment's limits for one grep call (the row's config after defaulting). */
export interface RichGrepCaps {
  /** Bytes kept of one printed line. */
  maxLineBytes: number;
  /** The complete raw ripgrep stdout a search may parse. */
  rawOutputMaxBytes: number;
  /** Terminate-escalation grace the subprocess seam grants past an abort. */
  graceMs: number;
  /** Bytes of ripgrep's stderr kept for messages and notes. */
  stderrMaxBytes: number;
  /** Cooperative tool-call budget, attached as the definition's `timeoutMs`. */
  timeoutMs: number;
}

/** One collected stream of a finished run (dsh-subprocess `readFrom(0)`). */
interface CollectedRead {
  text: string;
  lossy: boolean;
}

/** The slice of `ctx.subprocess` (dsh-subprocess) a search spawns through. */
export interface GrepSubprocess {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: {
      stdin: 'ignore';
      stdout: { maxBytes: number };
      stderr: { maxBytes: number };
    };
    graceMs: number;
    signal?: AbortSignal;
  }): {
    readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
    readonly collected: {
      readonly stdout?: { readFrom(fromByte: number): CollectedRead };
      readonly stderr?: { readFrom(fromByte: number): CollectedRead };
    };
  };
}

/** The slice of the row's Cordis context the tool uses. */
export interface RichGrepContext {
  tools: {
    register(definition: ToolDefinition): unknown;
    get(name: string, scope?: never): unknown;
  };
  systemPrompt: {
    section(section: {
      name: string;
      order: number;
      text: (assembly: { scope?: never }) => string;
    }): unknown;
    getSectionOrder(name: 'TOOL_GREP'): number;
  };
  subprocess: GrepSubprocess;
}

/** The part of a tool execution a search reads. */
export interface GrepExecution {
  readonly signal: AbortSignal;
  readonly agent?: { readonly session: { readonly header: { readonly cwd?: string } } };
}

/** Where ripgrep's resolution runs; tests point it at a binary of their own. */
export interface RichGrepDeps {
  rgPath?: () => Promise<string>;
}

const ABORTED = 'grep was aborted before completion (tool timeout or caller cancellation)';

interface RipgrepOutcome {
  stdout: string;
  /** ripgrep's own complaints, when exit 2 still printed results. */
  notes: string[];
  workdir: string;
}

async function runRipgrep(
  subprocess: GrepSubprocess,
  exec: GrepExecution,
  argv: readonly string[],
  caps: RichGrepCaps,
  rgPath: () => Promise<string>
): Promise<RipgrepOutcome> {
  if (exec.signal.aborted) throw new SearchError(ABORTED, 'SEARCH_ABORTED');
  const workdir = exec.agent?.session.header.cwd ?? process.cwd();
  let handle: ReturnType<GrepSubprocess['spawn']>;
  try {
    handle = subprocess.spawn({
      argv: [await rgPath(), '--no-config', ...argv],
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: caps.rawOutputMaxBytes },
        stderr: { maxBytes: caps.stderrMaxBytes },
      },
      graceMs: caps.graceMs,
      signal: exec.signal,
    });
  } catch (error) {
    if (exec.signal.aborted) throw new SearchError(ABORTED, 'SEARCH_ABORTED');
    throw new SearchError(
      'grep could not start its search command (ripgrep launch failed)',
      'SEARCH_FAILED',
      {
        cause: error,
      }
    );
  }
  let outcome: { exitCode: number | null; signal: string | null };
  try {
    outcome = await handle.done;
  } catch (error) {
    if (exec.signal.aborted) throw new SearchError(ABORTED, 'SEARCH_ABORTED');
    throw new SearchError(
      'grep subprocess failed before reporting an outcome (ripgrep provider failure)',
      'SEARCH_FAILED',
      { cause: error }
    );
  }
  if (exec.signal.aborted) throw new SearchError(ABORTED, 'SEARCH_ABORTED');
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);
  if (stdout === undefined || stderr === undefined) {
    throw new SearchError(
      'grep search command produced no collected output streams',
      'SEARCH_FAILED'
    );
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new SearchError(
      `grep search command was killed by signal ${outcome.signal ?? '(unknown)'}`,
      'SEARCH_FAILED'
    );
  }
  const complaint = `${stderr.text.trim()}${stderr.lossy ? ' [stderr truncated]' : ''}`;
  const failed = outcome.exitCode !== 0 && outcome.exitCode !== 1;
  // Exit 2 with results: ripgrep searched what it could and says what it could not.
  if (failed && !(outcome.exitCode === 2 && stdout.text.length > 0)) {
    if (/regex parse error|error parsing glob/i.test(complaint)) {
      throw new SearchError(
        `grep pattern rejected by ripgrep: ${complaint}`,
        'SEARCH_INVALID_PATTERN'
      );
    }
    throw new SearchError(
      `grep search failed (exit ${outcome.exitCode})${complaint ? `: ${complaint}` : ''}`,
      'SEARCH_FAILED'
    );
  }
  if (stdout.lossy || Buffer.byteLength(stdout.text, 'utf8') > caps.rawOutputMaxBytes) {
    throw new SearchError(
      `grep produced more than ${caps.rawOutputMaxBytes} bytes of raw output; narrow the pattern, path, glob or type, or use output_mode files_with_matches or count`,
      'SEARCH_RAW_OUTPUT_OVERFLOW'
    );
  }
  return {
    stdout: outcome.exitCode === 1 ? '' : stdout.text,
    notes: failed ? unreadablePathNotes(stderr.text) : [],
    workdir,
  };
}

/** Modification times of the listed files, a bounded number of `stat` calls at a time. */
async function modificationTimes(
  entries: readonly GrepEntry[],
  workdir: string,
  concurrency = 32
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (let index = 0; index < entries.length; index += concurrency) {
    const batch = entries.slice(index, index + concurrency);
    const stats = await Promise.all(
      batch.map((entry) => stat(resolve(workdir, entry.path)).catch(() => undefined))
    );
    batch.forEach((entry, at) => {
      const time = stats[at]?.mtimeMs;
      if (time !== undefined) times.set(entry.path, time);
    });
  }
  return times;
}

/** Run one checked call and build its canonical value. */
export async function searchGrep(
  subprocess: GrepSubprocess,
  exec: GrepExecution,
  input: GrepInput,
  caps: RichGrepCaps,
  rgPath: () => Promise<string> = resolveRgPath
): Promise<GrepValue> {
  const run = await runRipgrep(
    subprocess,
    exec,
    buildGrepArgv(input, GLOB_VCS_EXCLUDES),
    caps,
    rgPath
  );
  const display = (path: string) => toWorkdirRelative(path, run.workdir);
  try {
    if (input.outputMode === 'content') {
      return {
        mode: 'content',
        entries: orderContent(parseContentOutput(run.stdout, display, caps.maxLineBytes)),
        notes: run.notes,
      };
    }
    if (input.outputMode === 'count') {
      const entries = parseCountOutput(run.stdout, display).sort((a, b) =>
        comparePaths(a.path, b.path)
      );
      return { mode: 'count', entries, notes: run.notes };
    }
    const files = parseFilesOutput(run.stdout, display);
    const times = await modificationTimes(files, run.workdir);
    return {
      mode: 'files_with_matches',
      entries: orderByRecency(files, (path) => times.get(path)),
      notes: run.notes,
    };
  } catch (error) {
    if (error instanceof GrepOutputError) throw new SearchError(error.message, 'SEARCH_FAILED');
    throw error;
  }
}

/**
 * Register `grep` and its prompt section. The section takes dsh-tool-fs-search's
 * `tool:grep` name and `TOOL_GREP` slot, so the prompt keeps its layout.
 */
export function applyRichGrepTool(
  ctx: RichGrepContext,
  caps: RichGrepCaps,
  deps: RichGrepDeps = {}
): ToolDefinition {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => (ctx.tools.get('grep', scope) === undefined ? '' : GREP_TOOL_GUIDANCE),
  });
  const rgPath = deps.rgPath ?? resolveRgPath;
  const tool = defineTool({
    name: 'grep',
    description: GREP_TOOL_DESCRIPTION,
    parameters: GREP_PARAMETERS,
    timeoutMs: caps.timeoutMs,
    output: {
      schema: GREP_VALUE_SCHEMA,
      render: (args, value) => [
        { type: 'text', text: renderGrep(parseGrepArgs(args as GrepArgs), value as GrepValue) },
      ],
    },
    execute: (args, exec) =>
      searchGrep(ctx.subprocess, exec, parseGrepArgs(args as GrepArgs), caps, rgPath),
    presentCall: (args) => presentGrepCall(args as GrepArgs),
  });
  ctx.tools.register(tool);
  return tool;
}
