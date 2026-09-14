import { homedir } from 'node:os';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import { type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import { EXEC_SERVICE, HOST_IO_SERVICE, type RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import { type BashAnalysis, BashAnalyzer, splitShellPath } from '../permissions/bash-analysis.ts';
import { containsPath, PERMISSIONS_SERVICE, pathPolicy } from '../permissions/index.ts';
import { type AskUser, askTool } from './ask.ts';
import { browserPreviewTool, type PreviewHost } from './browserPreview.ts';
import { createFileChange, readBeforeChange } from './file-change.ts';
import { canonicalPath } from './paths.ts';
import { readLines } from './read-lines.ts';

export const TOOLS_SERVICE = 'runtimeTools';
export const TOOL_OUTPUT_BYTES = 50 * 1024;
const FILE_EDIT_BYTES = 8 * 1024 * 1024;
const SEARCH_FILE_BYTES = 1024 * 1024;
const SEARCH_ENTRIES = 20_000;
/** What a command gets when it does not ask for longer. Unchanged by P5-2-3. */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Ceiling for an explicit `timeoutSeconds`, matching the reference's 6 hours. */
export const MAX_BASH_TIMEOUT_SECONDS = 6 * 60 * 60;
/**
 * Filesystem races a traversal or a shell-path expansion must not fail on: a
 * dangling/looping symlink, a directory that vanished or was never there, or
 * one the process cannot read. Same set used elsewhere in this package for
 * "treat this entry as absent" (e.g. plugins/skills/index.ts).
 */
const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);
function isSkippableIoError(error: unknown): boolean {
  return OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '');
}
export interface ToolsConfig {
  cwd: string;
  recordFileChanges?: boolean;
  shellPath?: string;
  shellEnv?: Record<string, string>;
  /**
   * F5 — how the model reaches the user with a question. Absent registers no
   * `ask` tool at all, which is the honest state for a host with nowhere to
   * show one: a tool that always answers "nobody is listening" would still be
   * advertised, and the model would keep calling it.
   */
  ask?: AskUser;
  /**
   * P5-2-3 — where a previewable file is shown. Absent registers no
   * `browser_preview` tool, for the same reason `ask` is absent on a host with
   * nowhere to put a question.
   */
  preview?: PreviewHost;
}
export interface RuntimeToolsService {
  list(): readonly AgentTool<TSchema, unknown>[];
  register<T extends TSchema>(
    tool: AgentTool<T, unknown>,
    access?: 'read' | 'write' | 'shell'
  ): void;
}
declare module 'cordis' {
  interface Context {
    runtimeTools: RuntimeToolsService;
  }
}

export class ToolsPlugin extends Service implements RuntimeToolsService {
  static inject = [HOST_IO_SERVICE, EXEC_SERVICE, PERMISSIONS_SERVICE];
  private readonly registry = new Map<string, AgentTool<TSchema, unknown>>();
  private readonly access = new Map<string, 'read' | 'write' | 'shell'>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly config: ToolsConfig;
  private readonly bash: BashAnalyzer;
  constructor(ctx: Context, config: ToolsConfig) {
    super(ctx, TOOLS_SERVICE);
    this.config = config;
    this.bash = new BashAnalyzer(ctx.runtimeHostIo);
    this.install();
    ctx.effect(() => async () => {
      this.registry.clear();
      await this.bash.dispose();
    });
  }
  list(): readonly AgentTool<TSchema, unknown>[] {
    return [...this.registry.values()].filter(
      (tool) =>
        this.ctx.runtimePermissions.mode !== 'plan' || this.access.get(tool.name) !== 'write'
    );
  }
  register<T extends TSchema>(
    tool: AgentTool<T, unknown>,
    access: 'read' | 'write' | 'shell' = ['read', 'glob', 'grep'].includes(tool.name)
      ? 'read'
      : tool.name === 'bash'
        ? 'shell'
        : 'write'
  ): void {
    if (this.registry.has(tool.name)) throw new RuntimeHostError('duplicate_tool', tool.name);
    this.access.set(tool.name, access);
    // Validate at the registry boundary even for direct callers outside Agent.
    this.registry.set(tool.name, {
      ...tool,
      execute: async (id, params, signal, update) => {
        if (!this.ctx.runtimePermissions.isToolAllowed(tool.name))
          throw new RuntimeHostError('tool_denied', `tool is not allowed: ${tool.name}`);
        if (this.ctx.runtimePermissions.mode === 'plan' && access === 'write')
          throw new RuntimeHostError(
            'tool_unavailable_in_mode',
            `${tool.name} is unavailable in plan mode`
          );
        if (!Check(tool.parameters, params))
          throw new RuntimeHostError(
            'invalid_tool_arguments',
            `invalid arguments for ${tool.name}`
          );
        signal?.throwIfAborted();
        return tool.execute(id, params as Static<T>, signal, update);
      },
    });
  }
  private async target(
    tool: string,
    id: string,
    input: string,
    signal?: AbortSignal,
    command?: string,
    shell?: BashAnalysis,
    /** Content the approval card shows verbatim; see `ToolPermissionRequest`. */
    preview?: { label: string; text: string }
  ): Promise<string> {
    const io = this.ctx.runtimeHostIo;
    const lexical = resolve(this.config.cwd, input);
    if (pathPolicy(lexical) === 'deny')
      throw new RuntimeHostError('tool_denied', `access denied: ${lexical}`);
    const path = await canonicalPath(io, this.config.cwd, input);
    await this.ctx.runtimePermissions.authorize(
      {
        tool,
        toolCallId: id,
        path,
        command,
        paths: shell?.paths,
        commands: shell?.commands,
        unresolvedPaths: shell?.unresolvedPaths,
        exploration: shell?.exploration,
        ...(preview ? { preview } : {}),
      },
      signal
    );
    signal?.throwIfAborted();
    const current = await canonicalPath(io, this.config.cwd, input);
    if (current !== path)
      throw new RuntimeHostError(
        'path_changed',
        'path changed during approval; retry to authorize the new target'
      );
    return path;
  }
  private async locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const next = previous.then(() => gate);
    this.locks.set(path, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
    }
  }
  private async checkShellPaths(command: string): Promise<BashAnalysis> {
    const analysis = await this.bash.analyze(command, this.config.cwd, this.config.shellEnv ?? {});
    const paths = new Set<string>();
    let visits = 0;
    const check = async (lexical: string) => {
      if (++visits > 20_000)
        throw new RuntimeHostError(
          'shell_path_limit',
          'shell path expansion exceeds 20000 entries'
        );
      if (pathPolicy(lexical) === 'deny')
        throw new RuntimeHostError('tool_denied', `shell operand is denied: ${lexical}`);
      const canonical = await canonicalPath(this.ctx.runtimeHostIo, this.config.cwd, lexical);
      if (pathPolicy(canonical) === 'deny')
        throw new RuntimeHostError('tool_denied', `shell operand is denied: ${canonical}`);
      paths.add(lexical);
      paths.add(canonical);
    };
    const expand = async (path: string): Promise<void> => {
      // Split on either separator: a command writes `conf/*` even on Windows,
      // where splitting on `sep` alone leaves the wildcard glued to its parent
      // and every entry fails to match, so nothing gets checked.
      const parts = splitShellPath(path);
      const wildcard = parts.findIndex((part) => /[*?[]/.test(part));
      if (wildcard < 0) return check(path);
      const parent = parts.slice(0, wildcard).join(sep) || sep;
      await check(parent);
      // Even an unmatched pattern can target denied names after another command creates them.
      if (pathPolicy(path) === 'deny')
        throw new RuntimeHostError('tool_denied', `shell pattern is denied: ${path}`);
      try {
        for await (const entry of this.ctx.runtimeHostIo.readDirectory(parent)) {
          if (++visits > 20_000)
            throw new RuntimeHostError(
              'shell_path_limit',
              'shell path expansion exceeds 20000 entries'
            );
          if (entry.name.startsWith('.') && !parts[wildcard].startsWith('.')) continue;
          if (!matchesGlob(entry.name, parts[wildcard])) continue;
          await expand([parent, entry.name, ...parts.slice(wildcard + 1)].join(sep));
        }
      } catch (error) {
        // Parent doesn't exist / isn't a directory / isn't readable: a real
        // shell would just fail to expand the wildcard, not abort the command.
        if (!isSkippableIoError(error)) throw error;
      }
    };
    for (const path of analysis.paths) await expand(path);
    return { ...analysis, paths: [...paths].sort() };
  }
  private install(): void {
    const io = this.ctx.runtimeHostIo;
    const path = Type.String({ minLength: 1 });
    const objectOptions = { additionalProperties: false };
    // `read` access, so plan mode keeps it: a plan is exactly when the model
    // should be asking rather than deciding for the user.
    if (this.config.ask) this.register(askTool(this.config.ask), 'read');
    // `read` access: showing a file changes nothing on disk, and the reference
    // keeps BrowserPreview available in its read-only modes for the same reason.
    if (this.config.preview)
      this.register(
        browserPreviewTool(this.config.preview, (id, input, signal) =>
          this.target('browser_preview', id, input, signal)
        ),
        'read'
      );
    this.register({
      name: 'read',
      label: 'Read',
      description:
        'Read a UTF-8 file. offset is a one-based line number; limit is the number of lines. Output is capped at 50 KiB. Use nextOffset to continue.',
      parameters: Type.Object(
        {
          path,
          offset: Type.Optional(Type.Integer({ minimum: 1 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const target = await this.target('read', id, args.path, signal);
        if ((await io.stat(target)).kind !== 'file')
          throw new RuntimeHostError('invalid_tool_arguments', 'read requires a regular file');
        const data = await readLines(
          io,
          target,
          args.offset ?? 1,
          args.limit ?? 2000,
          TOOL_OUTPUT_BYTES,
          signal
        );
        return result(
          data.text +
            (data.truncated
              ? `\n[truncated; next line=${data.nextOffset}${data.partialLine ? '; single line exceeds byte budget' : ''}]`
              : ''),
          { path: target, ...data }
        );
      },
    });
    this.register({
      name: 'write',
      label: 'Write',
      description:
        'Write a complete UTF-8 file. Creates missing parent directories after approval.',
      parameters: Type.Object(
        { path, content: Type.String({ maxLength: FILE_EDIT_BYTES }) },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        if (Buffer.byteLength(args.content) > FILE_EDIT_BYTES)
          throw new RuntimeHostError('io_limit', 'write exceeds 8 MiB');
        const target = await this.target('write', id, args.path, signal, undefined, undefined, {
          label: 'Content',
          text: args.content,
        });
        return this.locked(target, async () => {
          signal?.throwIfAborted();
          const before =
            this.config.recordFileChanges !== false
              ? await readBeforeChange(io, target, signal)
              : undefined;
          signal?.throwIfAborted();
          await io.mkdir(dirname(target), { recursive: true });
          await io.writeFile(target, Buffer.from(args.content));
          return result(`Wrote ${Buffer.byteLength(args.content)} bytes to ${target}`, {
            path: target,
            ...(before ? { review: createFileChange(target, before, args.content) } : {}),
          });
        });
      },
    });
    this.register({
      name: 'edit',
      label: 'Edit',
      description:
        'Replace one exact occurrence of oldText with newText. All edits must match uniquely before writing.',
      parameters: Type.Object(
        {
          path,
          edits: Type.Array(
            Type.Object(
              { oldText: Type.String({ minLength: 1 }), newText: Type.String() },
              objectOptions
            ),
            { minItems: 1, maxItems: 100 }
          ),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const target = await this.target('edit', id, args.path, signal);
        return this.locked(target, async () => {
          const data = await io.readFile(target, {
            maxBytes: FILE_EDIT_BYTES,
            overflow: 'error',
            signal,
          });
          const before = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes);
          let content = before;
          for (const edit of args.edits) {
            const start = content.indexOf(edit.oldText);
            if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0)
              throw new RuntimeHostError(
                'edit_not_unique',
                'oldText must match exactly once; file was not changed'
              );
            content =
              content.slice(0, start) + edit.newText + content.slice(start + edit.oldText.length);
            if (Buffer.byteLength(content) > FILE_EDIT_BYTES)
              throw new RuntimeHostError('io_limit', 'edited file exceeds 8 MiB');
          }
          signal?.throwIfAborted();
          await io.writeFile(target, Buffer.from(content));
          return result(`Applied ${args.edits.length} edits to ${target}`, {
            path: target,
            ...(this.config.recordFileChanges !== false
              ? { review: createFileChange(target, { text: before }, content) }
              : {}),
          });
        });
      },
    });
    this.register({
      name: 'bash',
      label: 'Bash',
      description:
        'Execute a command with the configured shell in the workspace. Output is bounded. Runtime is bounded too: 120s unless you name a longer one with timeoutSeconds, which a build or a full test run will need.',
      parameters: Type.Object(
        {
          command: Type.String({ minLength: 1, maxLength: 32768 }),
          /**
           * P5-2-3. The reference's Bash defaults to 60s and allows up to 6h;
           * ours defaulted to 120s and CAPPED at 10 minutes, which is shorter
           * than a real build. `test-runner` and `fixer` exist to run exactly
           * those commands, so the ceiling had to move.
           *
           * Two decisions inside that, both from the contract:
           *
           * - The no-argument default stays 120s. A command that did not ask
           *   for longer does not silently get to hang for six hours.
           * - The new knob is in SECONDS, matching the reference's interface
           *   (converted to ms here). `timeoutMs` stays for callers that
           *   already pass it; when both are given, the explicit seconds win
           *   because that is the one a model reaches for.
           */
          timeoutSeconds: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_BASH_TIMEOUT_SECONDS })
          ),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const analysis = await this.checkShellPaths(args.command);
        const cwd = await this.target('bash', id, '.', signal, args.command, analysis);
        const current = await this.checkShellPaths(args.command);
        if (JSON.stringify(current.paths) !== JSON.stringify(analysis.paths))
          throw new RuntimeHostError('path_changed', 'shell paths changed during approval; retry');
        if (!this.config.shellPath)
          throw new RuntimeHostError(
            'shell_unconfigured',
            'host must configure the shell executable'
          );
        const output = await this.ctx.runtimeExec.run({
          command: this.config.shellPath,
          args: ['--noprofile', '--norc', '-c', args.command],
          env: {
            HOME: this.config.shellEnv?.HOME ?? homedir(),
            BASH_ENV: undefined,
            ENV: undefined,
            SHELLOPTS: undefined,
            BASHOPTS: undefined,
          },
          cwd,
          timeoutMs: args.timeoutSeconds
            ? args.timeoutSeconds * 1000
            : (args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS),
          maxOutputBytes: TOOL_OUTPUT_BYTES,
          overflow: 'truncate',
          signal,
        });
        return result(
          `${Buffer.from(output.stdout).toString('utf8')}${output.stderr.length ? `\n[stderr]\n${Buffer.from(output.stderr).toString('utf8')}` : ''}\n[exit=${output.exitCode}; ${output.termination}${output.truncated ? '; output truncated' : ''}]`,
          output
        );
      },
    });
    this.register({
      name: 'glob',
      label: 'Glob',
      description:
        'Find files using a glob pattern. Skips symlinks, .git and node_modules; does not read file contents.',
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 512 }),
          path: Type.Optional(path),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const root = await this.target('glob', id, args.path ?? '.', signal);
        const found: string[] = [];
        const budget = { visited: 0, truncated: false };
        for await (const file of walk(
          io,
          root,
          budget,
          (file) =>
            this.ctx.runtimePermissions.canTraverse({ tool: 'glob', toolCallId: id, path: file }),
          signal
        )) {
          if (matchesGlob(relative(root, file), args.pattern)) found.push(file);
          if (found.length >= (args.limit ?? 100)) {
            budget.truncated = true;
            break;
          }
        }
        return result(
          found.join('\n') +
            (budget.truncated ? '\n[search truncated; narrow the search or increase limit]' : ''),
          {
            files: found,
            truncated: budget.truncated,
            visited: budget.visited,
          }
        );
      },
    });
    this.register({
      name: 'grep',
      label: 'Grep',
      description:
        'Search UTF-8 files for text. Literal by default; set regex:true to treat pattern as a JavaScript regular expression. Skips symlinks, .git, node_modules, binary files and denied paths; bounded to 1 MiB per file.',
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 1024 }),
          path: Type.Optional(path),
          include: Type.Optional(Type.String({ maxLength: 512 })),
          caseInsensitive: Type.Optional(Type.Boolean()),
          /**
           * P5-2-3. The reference's `Grep` is ripgrep, so regex is its default
           * and the builtin `explorer` prompt tells a delegate to reach for it.
           * Ours was literal-only, which made that instruction a lie.
           *
           * Added as an opt-in flag rather than by flipping the default: a
           * literal search for `a.b` finding `axb` is a silent behaviour change
           * to a tool the parent agent and P1-4's cases already rely on. The
           * capability gap closes either way; the difference is whether closing
           * it also rewrites what every existing call means.
           */
          regex: Type.Optional(Type.Boolean()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const root = await this.target('grep', id, args.path ?? '.', signal);
        const matches: string[] = [];
        const budget = { visited: 0, truncated: false };
        let totalBytes = 0;
        let skipped = 0;
        const needle = args.caseInsensitive ? args.pattern.toLowerCase() : args.pattern;
        // Compiled once, outside the walk. A bad pattern must fail the CALL,
        // not silently match nothing across a whole tree - the model has no way
        // to tell "no hits" from "your regex was invalid" otherwise.
        let expression: RegExp | undefined;
        if (args.regex) {
          try {
            expression = new RegExp(args.pattern, args.caseInsensitive ? 'i' : '');
          } catch (error) {
            throw new RuntimeHostError(
              'invalid_tool_arguments',
              `grep: invalid regular expression ${JSON.stringify(args.pattern)} (${
                error instanceof Error ? error.message : String(error)
              })`
            );
          }
        }
        const hits = (line: string): boolean =>
          expression
            ? expression.test(line)
            : (args.caseInsensitive ? line.toLowerCase() : line).includes(needle);
        for await (const file of walk(
          io,
          root,
          budget,
          (file) =>
            this.ctx.runtimePermissions.canTraverse({ tool: 'grep', toolCallId: id, path: file }),
          signal
        )) {
          if (args.include && !matchesGlob(relative(root, file), args.include)) continue;
          if (pathPolicy(file) !== 'allow') {
            skipped++;
            continue;
          }
          const data = await io.readFile(file, {
            maxBytes: SEARCH_FILE_BYTES,
            overflow: 'truncate',
            signal,
          });
          totalBytes += data.bytes.length;
          if (totalBytes > 32 * 1024 * 1024) {
            budget.truncated = true;
            break;
          }
          if (data.truncated) budget.truncated = true;
          if (data.bytes.includes(0)) {
            skipped++;
            continue;
          }
          const lines = Buffer.from(data.bytes).toString('utf8').split('\n');
          for (let line = 0; line < lines.length; line++) {
            if (hits(lines[line])) {
              matches.push(`${file}:${line + 1}:${lines[line].slice(0, 2048)}`);
              if (matches.length >= (args.limit ?? 100)) break;
            }
          }
          if (matches.length >= (args.limit ?? 100)) {
            budget.truncated = true;
            break;
          }
        }
        return result(
          matches.join('\n') + (budget.truncated ? '\n[search truncated; narrow the search]' : ''),
          {
            truncated: budget.truncated,
            skipped,
            visited: budget.visited,
          }
        );
      },
    });
  }
}
function result(text: string, details: unknown): AgentToolResult<unknown> {
  const bytes = Buffer.from(text);
  if (bytes.length > TOOL_OUTPUT_BYTES)
    text = `${decodeUtf8(bytes.subarray(0, TOOL_OUTPUT_BYTES), true).text}\n[output truncated]`;
  return { content: [{ type: 'text', text }], details };
}
function decodeUtf8(bytes: Uint8Array, truncated: boolean): { text: string; bytes: number } {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const text = decoder.decode(bytes, { stream: truncated });
  if (truncated && bytes.length && !text.length)
    throw new RuntimeHostError(
      'read_window_too_small',
      'use a limit of at least four bytes for UTF-8 text'
    );
  return { text, bytes: Buffer.byteLength(text) };
}
async function* walk(
  io: RuntimeHostIoService,
  root: string,
  budget: { visited: number; truncated: boolean },
  allowed: (path: string) => boolean,
  signal?: AbortSignal
): AsyncIterable<string> {
  if ((await io.stat(root)).kind === 'file') {
    if (allowed(root)) yield root;
    return;
  }
  const stack = [root];
  while (stack.length) {
    signal?.throwIfAborted();
    const directory = stack.pop();
    if (!directory) break;
    try {
      for await (const entry of io.readDirectory(directory)) {
        signal?.throwIfAborted();
        if (++budget.visited > SEARCH_ENTRIES) {
          budget.truncated = true;
          return;
        }
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const path = join(directory, entry.name);
        if (!allowed(path)) continue;
        // The dirent already says it's a symlink; realpath would only tell us
        // whether it's dangling/looping, and we skip it either way.
        if (entry.kind === 'symlink') continue;
        let canonical: string;
        try {
          canonical = await io.realpath(path);
        } catch (error) {
          if (!isSkippableIoError(error)) throw error;
          continue;
        }
        if (!containsPath(root, canonical) || canonical !== path) continue;
        if (entry.kind === 'directory') stack.push(path);
        else if (entry.kind === 'file') yield path;
      }
    } catch (error) {
      // A directory that vanished mid-walk or one we can't read (EACCES)
      // shouldn't fail the whole search — skip it and keep going.
      if (!isSkippableIoError(error)) throw error;
    }
  }
}
