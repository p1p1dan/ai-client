import { homedir } from 'node:os';
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import { type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import { decodeConsoleOutput } from '../../../shared/windowsCodePage.ts';
import {
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  PROMPT_SERVICE,
  type RuntimeHostIoService,
  type RuntimeReadResult,
} from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import { type BashAnalysis, BashAnalyzer, splitShellPath } from '../permissions/bash-analysis.ts';
import { containsPath, PERMISSIONS_SERVICE, pathPolicy } from '../permissions/index.ts';
import { type AskUser, askTool } from './ask.ts';
import { browserPreviewTool, type PreviewHost } from './browserPreview.ts';
import { createFileChange, readBeforeChange } from './file-change.ts';
import { type IgnoreLayer, isIgnored, parseGitignore } from './gitignore.ts';
import { canonicalPath } from './paths.ts';
import {
  hasImageExtension,
  type ImageReadBudget,
  readBinaryAsImage,
  readImage,
  unsupportedFile,
} from './read-image.ts';
import { decodeFileText, type ReadLinesResult, readLines, utf8FileDecoder } from './read-lines.ts';

export const TOOLS_SERVICE = 'runtimeTools';
export const TOOL_OUTPUT_BYTES = 50 * 1024;
const FILE_EDIT_BYTES = 8 * 1024 * 1024;
const SEARCH_FILE_BYTES = 1024 * 1024;
const SEARCH_ENTRIES = 20_000;
/**
 * Room `read` keeps inside TOOL_OUTPUT_BYTES for its own continuation line, so
 * the line number survives a full window instead of being cut off by the
 * generic truncation in `result` (tools-03).
 */
const READ_STATUS_BYTES = 128;
/**
 * Wall clock a model-authored regular expression gets for one file, and for the
 * whole search. JS regex execution is not interruptible, so these are checked
 * between lines: they bound a pattern that is merely slow on many lines, and
 * they are the only thing that lets Stop land during a long scan (tools-09).
 */
const GREP_FILE_SCAN_MS = 1_000;
const GREP_TOTAL_SCAN_MS = 5_000;
/** How often the line scan checks for cancellation. */
const GREP_SCAN_CHECK_LINES = 256;
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
/**
 * What a bulk reader must treat as "this one file cannot be scanned" rather
 * than "the search failed" (tsd-02).
 *
 * T010 gave the traversal this tolerance and left the read that follows it
 * bare, so a single `chmod 000` file — or, on an encrypted box, one file this
 * carrier cannot decrypt — threw away every match already found. The result
 * already reports how many files were skipped, which is where these belong.
 */
const UNSCANNABLE_FILE_ERRORS = new Set([
  'io_tsd_unavailable',
  'io_tsd_unreadable',
  'io_not_utf8',
  'io_limit',
]);
function isUnscannableFile(error: unknown): boolean {
  const code = errorCode(error) ?? '';
  return OPTIONAL_FILE_ERRORS.has(code) || UNSCANNABLE_FILE_ERRORS.has(code);
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
  /** Start a fresh per-run image budget for `read`; the agent loop calls it per run. */
  beginRun(): void;
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
  /**
   * Image bytes `read` has returned in the current run, against
   * `ATTACHMENT_TURN_STORED_BYTES` (see `read-image.ts`).
   *
   * Kept here and reset by the agent loop's `beginRun`, not keyed on the call's
   * signal: pi mints a new signal per `prompt()`/`continue()`, and one run makes
   * several of those (delegation resume, stream recovery), each of which would
   * otherwise hand the model a fresh budget. Delegates share this plugin, so
   * their reads count against the run that is current, which errs towards
   * refusing. Without an agent loop (direct callers) it is one lifetime budget.
   */
  private imageBudget: ImageReadBudget = { used: 0 };
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
  beginRun(): void {
    // A new object rather than a reset, so a call still in flight from the
    // previous run charges the budget it started under.
    this.imageBudget = { used: 0 };
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
  /**
   * decision 007 — tell the prompt service which files this call actually
   * reached, so a subdirectory's instruction file can come into scope.
   *
   * Called after the operation succeeded, not next to `target()`: an approval
   * that was granted and then failed on a missing file is not the agent
   * "working in" that directory. Looked up through `ctx.get` rather than
   * injected, because this plugin is registered BEFORE the prompt service and a
   * hard dependency would invert the graph for a purely optional signal.
   *
   * Swallows everything. A tool result must not turn into an error because an
   * AGENTS.md beside the file was unreadable.
   */
  private async noteInstructionScope(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.ctx.get(PROMPT_SERVICE)?.noteFilesTouched?.(paths);
    } catch {
      // Intentionally ignored; see above.
    }
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
        'Read a UTF-8 text file or a PNG, JPEG, GIF or WebP image. For text, offset is a one-based line number and limit is the number of lines; output is capped at 50 KiB; use nextOffset to continue. An image (up to 5 MiB) is returned as an image and offset/limit are ignored. Other binary files are refused.',
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
        const info = await io.stat(target);
        if (info.kind !== 'file')
          throw new RuntimeHostError('invalid_tool_arguments', 'read requires a regular file');
        // Captured now: a run that begins while this call is in flight must not
        // be charged for it.
        const budget = this.imageBudget;
        // The extension only decides which side is tried first; the bytes
        // decide what the file is. A text read with any other name pays for no
        // extra IO unless its bytes turn out not to be UTF-8.
        const imageFirst = hasImageExtension(target);
        if (imageFirst) {
          const image = await readImage(io, target, info.size, budget, signal);
          if (image) {
            await this.noteInstructionScope([target]);
            return image;
          }
        }
        const offset = args.offset ?? 1;
        let lines: ReadLinesResult;
        try {
          lines = await readLines(
            io,
            target,
            offset,
            args.limit ?? 2000,
            TOOL_OUTPUT_BYTES - READ_STATUS_BYTES,
            signal
          );
        } catch (error) {
          if (errorCode(error) !== 'io_not_utf8') throw error;
          // Already sniffed above when the name said image.
          if (imageFirst) throw unsupportedFile(target);
          const image = await readBinaryAsImage(io, target, info.size, budget, signal);
          await this.noteInstructionScope([target]);
          return image;
        }
        const { text, ...data } = lines;
        await this.noteInstructionScope([target]);
        // Each truncation reason gets its own wording: "one line is too long"
        // sends the model hunting for that line, which is wrong advice when the
        // window simply filled up (tools-13).
        const reason = data.longLine
          ? `; line ${data.nextOffset - 1} alone exceeds the byte budget and the rest of it was skipped`
          : data.partialLine
            ? '; the byte budget filled mid-line, so that line is re-read'
            : '';
        return result(
          text || (offset > 1 ? `(no lines at offset ${offset})` : '(empty file)'),
          // Not `text`: the content block already carries it, and a second copy
          // is persisted into the session and the trace (tools-06).
          { path: target, bytes: Buffer.byteLength(text), ...data },
          data.truncated ? `\n[truncated; next line=${data.nextOffset}${reason}]` : ''
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
          await this.noteInstructionScope([target]);
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
          const before = decodeFileText(utf8FileDecoder(), data.bytes, false, target);
          let content = before;
          for (const edit of args.edits) {
            content = applyEdit(content, edit.oldText, edit.newText);
            if (Buffer.byteLength(content) > FILE_EDIT_BYTES)
              throw new RuntimeHostError('io_limit', 'edited file exceeds 8 MiB');
          }
          signal?.throwIfAborted();
          await io.writeFile(target, Buffer.from(content));
          await this.noteInstructionScope([target]);
          return result(`Applied ${args.edits.length} edits to ${target}`, {
            path: target,
            ...(this.config.recordFileChanges !== false
              ? { review: createFileChange(target, { text: before }, content) }
              : {}),
          });
        });
      },
    });
    // windows-04 — no shell, no tool. `resolveWorkerShell` finds nothing on a
    // Windows box without Git for Windows, and advertising `bash` there bought
    // the model an English "host must configure the shell executable" on every
    // call, which it answers by rephrasing the command and trying again. Same
    // rule `ask` and `browser_preview` above already follow: a tool nobody can
    // execute is not offered.
    if (this.config.shellPath) {
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
        execute: async (id, args, signal, update) => {
          const analysis = await this.checkShellPaths(args.command);
          const cwd = await this.target('bash', id, '.', signal, args.command, analysis);
          const current = await this.checkShellPaths(args.command);
          if (JSON.stringify(current.paths) !== JSON.stringify(analysis.paths))
            throw new RuntimeHostError(
              'path_changed',
              'shell paths changed during approval; retry'
            );
          if (!this.config.shellPath)
            throw new RuntimeHostError(
              'shell_unconfigured',
              'host must configure the shell executable'
            );
          // T146 — the row's live clock (and the timeout tail next to it) must
          // count from here, not from `tool.started`: that fires while
          // arguments are still streaming, so its own elapsed already
          // includes arg streaming, the approval wait and the path re-check
          // above. This is the instant `timeoutMs` below actually starts
          // being enforced.
          update?.({ content: [], details: { execStartedAt: Date.now() } });
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
          // windows-09 — a Windows native command (`dir`, `python`, a build tool)
          // writes the OEM code page, not UTF-8, and `toString('utf8')` turns
          // that into replacement characters the model then reasons about. Valid
          // UTF-8 still wins, so Git Bash's own output is unaffected; `truncated`
          // keeps a character the output budget cut in half from looking like a
          // different encoding.
          const decode = (bytes: Uint8Array) =>
            decodeConsoleOutput(bytes, { truncated: output.truncated });
          return result(
            `${decode(output.stdout)}${output.stderr.length ? `\n[stderr]\n${decode(output.stderr)}` : ''}`,
            // Scalars only. The raw result carries stdout/stderr as Uint8Array,
            // which JSON.stringify writes to the session and the trace as one
            // object key per byte (tools-06).
            {
              exitCode: output.exitCode,
              signal: output.signal,
              termination: output.termination,
              stdoutBytes: output.stdoutBytes,
              stderrBytes: output.stderrBytes,
              truncated: output.truncated,
              // windows-02 — a tree we could not confirm dead is reported here
              // and nowhere else: the command's own outcome above is complete,
              // and reaping it is a separate concern that used to be allowed to
              // fail the whole call.
              ...(output.cleanupError ? { cleanupError: output.cleanupError } : {}),
              // T130 — cut short by Stop (or the runtime going away). The text
              // and the status tail stay as they are, so the model still sees
              // the partial output; `stoppedToolOutcome` turns this into
              // `isError` and the projector carries it to the row.
              ...(output.termination === 'aborted' || output.termination === 'disposed'
                ? { stopped: true }
                : {}),
            },
            `\n[exit=${output.exitCode}; ${output.termination}${output.truncated ? '; output truncated' : ''}]`
          );
        },
      });
    }
    this.register({
      name: 'glob',
      label: 'Glob',
      description:
        'Find files using a glob pattern. A pattern without "/" matches a file name at any depth, so *.ts finds src/a.ts. Skips symlinks, .git, node_modules and paths a .gitignore in the tree excludes; set respectGitignore:false to search build output too. Does not read file contents.',
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 512 }),
          path: Type.Optional(path),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
          respectGitignore: Type.Optional(Type.Boolean()),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const root = await this.target('glob', id, args.path ?? '.', signal);
        const found: string[] = [];
        const limit = args.limit ?? 100;
        const matches = globMatcher(root, args.pattern);
        const budget = { visited: 0, truncated: false, ignored: 0 };
        // Resolved once. `this.ctx` is a cordis Proxy, so reading a service off
        // it per directory entry cost more than the permission check it was
        // fetching (tools-20).
        const permissions = this.ctx.runtimePermissions;
        for await (const file of walk(
          io,
          root,
          budget,
          (file) => permissions.canTraverse({ tool: 'glob', toolCallId: id, path: file }),
          signal,
          { respectGitignore: args.respectGitignore }
        )) {
          if (!matches(file)) continue;
          found.push(file);
          // One hit past the limit is what proves there was more to return;
          // stopping AT the limit cannot tell "there is more" from "that was
          // all", and the model pays for a second full walk (tools-14).
          if (found.length > limit) {
            found.pop();
            budget.truncated = true;
            break;
          }
        }
        return result(
          // Never an empty text block: "searched, found nothing" has to read
          // differently from "the tool did nothing" (tools-02).
          found.join('\n') || 'No files matched.',
          {
            files: found,
            truncated: budget.truncated,
            visited: budget.visited,
            ...(budget.ignored ? { ignored: budget.ignored } : {}),
          },
          budget.truncated
            ? '\n[search truncated; narrow the search or increase limit]'
            : ignoreNote(found.length, budget)
        );
      },
    });
    this.register({
      name: 'grep',
      label: 'Grep',
      description:
        'Search UTF-8 files for text. Literal by default; set regex:true to treat pattern as a JavaScript regular expression. include is a glob; without "/" it matches a file name at any depth, so *.ts covers src/a.ts. Skips symlinks, .git, node_modules, binary files, denied paths and paths a .gitignore in the tree excludes; set respectGitignore:false to search build output too. Bounded to 1 MiB per file.',
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
          respectGitignore: Type.Optional(Type.Boolean()),
        },
        objectOptions
      ),
      execute: async (id, args, signal) => {
        const root = await this.target('grep', id, args.path ?? '.', signal);
        const matches: string[] = [];
        const hitDirectories = new Set<string>();
        const budget = { visited: 0, truncated: false, ignored: 0 };
        const limit = args.limit ?? 100;
        const included = args.include ? globMatcher(root, args.include) : undefined;
        let totalBytes = 0;
        let skipped = 0;
        let scanMs = 0;
        let timedOut = false;
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
        // See `glob`: one Proxy read instead of one per entry (tools-20).
        const permissions = this.ctx.runtimePermissions;
        for await (const file of walk(
          io,
          root,
          budget,
          (file) => permissions.canTraverse({ tool: 'grep', toolCallId: id, path: file }),
          signal,
          { respectGitignore: args.respectGitignore }
        )) {
          if (included && !included(file)) continue;
          if (pathPolicy(file) !== 'allow') {
            skipped++;
            continue;
          }
          let data: RuntimeReadResult;
          try {
            data = await io.readFile(file, {
              maxBytes: SEARCH_FILE_BYTES,
              overflow: 'truncate',
              signal,
            });
          } catch (error) {
            // The same treatment the walk gives an entry it cannot open. An
            // abort or a disposed runtime is not in the set, so Stop and
            // shutdown still end the search.
            if (!isUnscannableFile(error)) throw error;
            skipped++;
            continue;
          }
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
          // Splitting on '\n' alone leaves the carriage return of a CRLF file on
          // every line: a `$` anchor then never matches, and the reported text
          // carries the stray byte (tools-17).
          const lines = Buffer.from(data.bytes).toString('utf8').split(/\r?\n/);
          const startedAt = Date.now();
          let overflow = false;
          for (let line = 0; line < lines.length; line++) {
            // A regex runs synchronously, so Stop can only land between lines.
            if (line % GREP_SCAN_CHECK_LINES === 0) signal?.throwIfAborted();
            if (expression && Date.now() - startedAt > GREP_FILE_SCAN_MS) {
              timedOut = true;
              break;
            }
            if (!hits(lines[line])) continue;
            // decision 007 — a file the search MATCHED is a file the agent is
            // now working with; a file merely walked past is not, so the note
            // rides the match rather than the walk.
            hitDirectories.add(file);
            matches.push(`${file}:${line + 1}:${lines[line].slice(0, 2048)}`);
            if (matches.length > limit) {
              matches.pop();
              overflow = true;
              break;
            }
          }
          scanMs += Date.now() - startedAt;
          // A pattern that blew one file's budget would blow the next 20 000
          // too, so the search stops rather than paying that per file.
          if (timedOut || scanMs > GREP_TOTAL_SCAN_MS) {
            timedOut = true;
            budget.truncated = true;
            break;
          }
          if (overflow) {
            budget.truncated = true;
            break;
          }
        }
        // Once for the whole search rather than per hit: the walk is the hot
        // loop here, and the tracker de-duplicates by directory anyway.
        await this.noteInstructionScope([...hitDirectories]);
        return result(
          matches.join('\n') || 'No matches found.',
          {
            truncated: budget.truncated,
            skipped,
            visited: budget.visited,
            ...(budget.ignored ? { ignored: budget.ignored } : {}),
            ...(timedOut ? { timedOut: true } : {}),
          },
          timedOut
            ? '\n[search stopped: the pattern is too slow over this tree; simplify the regular expression]'
            : budget.truncated
              ? '\n[search truncated; narrow the search]'
              : ignoreNote(matches.length, budget)
        );
      },
    });
  }
}
const OUTPUT_TRUNCATED_NOTE = '\n[output truncated]';
/**
 * `status` is what the tool appends about itself — the continuation line, the
 * exit code, the truncation notice. It gets its budget reserved BEFORE the body
 * is cut, because a body that fills the window would otherwise push the one
 * part the model needs past the truncation point (tools-03).
 */
function result(text: string, details: unknown, status = ''): AgentToolResult<unknown> {
  const bytes = Buffer.from(text);
  const reserved = Buffer.byteLength(status);
  if (bytes.length + reserved > TOOL_OUTPUT_BYTES) {
    const room = Math.max(
      0,
      TOOL_OUTPUT_BYTES - reserved - Buffer.byteLength(OUTPUT_TRUNCATED_NOTE)
    );
    text = `${decodeUtf8(bytes.subarray(0, room), true).text}${OUTPUT_TRUNCATED_NOTE}`;
  }
  // A tool that produced nothing still says so; an empty text block reads as
  // "the tool did nothing" to the model and to the timeline (tools-02).
  return { content: [{ type: 'text', text: `${text || '(no output)'}${status}` }], details };
}
/**
 * Apply one `edit` entry, tolerating a different line-end spelling (windows-05).
 *
 * An exact byte match is tried first, so nothing changes for the common case.
 * What changes is the CRLF one: on Windows `core.autocrlf` is on by default, so
 * a checked-out file is CRLF, while a model that quotes several lines back
 * normally sends them with plain newlines. That used to miss, report
 * `edit_not_unique` — which names the wrong cause — and push the model towards
 * rewriting the whole file with `write`, turning a three-line change into a
 * whole-file diff. The retry re-spells `oldText` in the file's own endings and
 * re-spells `newText` the same way, so the file keeps the endings it had.
 */
function applyEdit(content: string, oldText: string, newText: string): string {
  const toCrlf = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const toLf = (text: string) => text.replace(/\r\n/g, '\n');
  const spellings: { fold: (text: string) => string; retried: boolean }[] = [
    { fold: (text) => text, retried: false },
    { fold: toCrlf, retried: true },
    { fold: toLf, retried: true },
  ];
  for (const { fold, retried } of spellings) {
    const needle = fold(oldText);
    if (retried && needle === oldText) continue;
    const start = content.indexOf(needle);
    if (start < 0) continue;
    if (content.indexOf(needle, start + 1) >= 0)
      throw new RuntimeHostError(
        'edit_not_unique',
        `oldText must match exactly once; file was not changed${
          retried ? ` (matched ${describeEndings(needle)} line endings, more than once)` : ''
        }`
      );
    return content.slice(0, start) + fold(newText) + content.slice(start + needle.length);
  }
  throw new RuntimeHostError(
    'edit_not_unique',
    `oldText must match exactly once; file was not changed${endingMismatch(content, oldText)}`
  );
}
function describeEndings(text: string): 'CRLF' | 'LF' {
  return text.includes('\r\n') ? 'CRLF' : 'LF';
}
/** Says so when the file and `oldText` disagree about line endings, and stays quiet otherwise. */
function endingMismatch(content: string, oldText: string): string {
  if (!/\n/.test(oldText)) return '';
  const file = describeEndings(content);
  if (file === describeEndings(oldText)) return '';
  return ` (the file uses ${file} line endings and oldText uses ${describeEndings(
    oldText
  )}; it was retried with ${file} endings and still did not match)`;
}
/**
 * A pattern with no separator names a file rather than a path, so it has to
 * match at any depth — that is what ripgrep's `--glob` and the legacy backend
 * do, and `*.ts` is what a model writes. `relative` is empty when the search
 * root IS the file, so fall back to its name there too (tools-08).
 */
function globMatcher(root: string, pattern: string): (file: string) => boolean {
  const anyDepth = !pattern.includes('/') && !pattern.includes(sep);
  return (file) => {
    const candidate = relative(root, file) || basename(file);
    return (
      matchesGlob(candidate, pattern) || (anyDepth && matchesGlob(basename(candidate), pattern))
    );
  };
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
/**
 * Say so when a search came back empty and `.gitignore` is why it might have.
 *
 * Only on an empty result, and only when something was actually skipped: a
 * search that found what it was looking for does not need the footnote, and a
 * model that reads one on every call learns to ignore it. Without this, "No
 * files matched" is indistinguishable from "the file is in an ignored build
 * directory", and the model's next move is to reach for the shell.
 */
function ignoreNote(hits: number, budget: WalkBudget): string {
  if (hits || !budget.ignored) return '';
  return `\n[${budget.ignored} ${
    budget.ignored === 1 ? 'entry was' : 'entries were'
  } skipped by .gitignore; pass respectGitignore:false to search them]`;
}
/** What a search reports about the tree it crossed, rather than about its hits. */
interface WalkBudget {
  visited: number;
  truncated: boolean;
  /** Entries a `.gitignore` in scope hid. Zero when `respectGitignore` is off. */
  ignored: number;
}
/**
 * Walk a tree, yielding the files a search may look at.
 *
 * ## Why realpath happens once per directory and not once per entry (tools-20)
 *
 * The root arrives canonical — `target` resolves it through `canonicalPath` —
 * and a `symlink` dirent is skipped rather than followed, so every path this
 * produces is canonical as well. The per-entry `realpath` that used to prove
 * that was therefore answering a question that could not come out any other
 * way, and it dominated the walk: on a 19 000-file tree it was about 80% of the
 * wall clock on Linux, and on Windows it is worse, because realpath there
 * resolves the WHOLE path on every call rather than one component. A field run
 * on a C++ workspace spent 50 s in a single `glob` because of it.
 *
 * What is kept is one realpath per directory ENTERED, which still refuses a
 * directory that resolves outside the root, plus a set of the canonical
 * directories already walked so a cycle cannot loop forever.
 */
async function* walk(
  io: RuntimeHostIoService,
  root: string,
  budget: WalkBudget,
  allowed: (path: string) => boolean,
  signal?: AbortSignal,
  options: { respectGitignore?: boolean } = {}
): AsyncIterable<string> {
  if ((await io.stat(root)).kind === 'file') {
    if (allowed(root)) yield root;
    return;
  }
  const respectGitignore = options.respectGitignore !== false;
  const seen = new Set<string>();
  const stack: { path: string; layers: readonly IgnoreLayer[] }[] = [{ path: root, layers: [] }];
  while (stack.length) {
    signal?.throwIfAborted();
    const current = stack.pop();
    if (!current) break;
    let canonical: string;
    try {
      canonical = await io.realpath(current.path);
    } catch (error) {
      if (!isSkippableIoError(error)) throw error;
      continue;
    }
    if (!containsPath(root, canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    const layers = respectGitignore
      ? await ignoreLayers(io, current.path, current.layers, allowed, signal)
      : current.layers;
    try {
      for await (const entry of io.readDirectory(current.path)) {
        signal?.throwIfAborted();
        if (++budget.visited > SEARCH_ENTRIES) {
          budget.truncated = true;
          return;
        }
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        // Only ordinary files and directories. A symlink is dropped here rather
        // than resolved: the dirent already says what it is, and realpath would
        // only add whether it is dangling or looping, which changes nothing —
        // it is skipped either way. Sockets, devices and FIFOs go the same way.
        if (entry.kind !== 'file' && entry.kind !== 'directory') continue;
        const path = join(current.path, entry.name);
        // Ahead of the permission check on purpose: an ignored build tree is
        // the case this exists for, and asking the gate about each of its
        // 12 000 object files first would spend exactly what it saves.
        if (layers.length && isIgnored(layers, path, entry.kind === 'directory')) {
          budget.ignored++;
          continue;
        }
        if (!allowed(path)) continue;
        if (entry.kind === 'directory') stack.push({ path, layers });
        else yield path;
      }
    } catch (error) {
      // A directory that vanished mid-walk or one we can't read (EACCES)
      // shouldn't fail the whole search — skip it and keep going.
      if (!isSkippableIoError(error)) throw error;
    }
  }
}
/** How much of a `.gitignore` is read before the rest is ignored. */
const GITIGNORE_BYTES = 128 * 1024;
/**
 * The ignore layers in scope inside `directory`: whatever it inherited, plus
 * its own `.gitignore` when there is one to read.
 *
 * Every failure short of cancellation answers "no extra rules". A `.gitignore`
 * that is missing, unreadable, binary or actually a directory must not fail a
 * search — the worst it can cost is a few thousand files the model did not need
 * to see.
 */
async function ignoreLayers(
  io: RuntimeHostIoService,
  directory: string,
  inherited: readonly IgnoreLayer[],
  allowed: (path: string) => boolean,
  signal?: AbortSignal
): Promise<readonly IgnoreLayer[]> {
  const file = join(directory, '.gitignore');
  if (!allowed(file)) return inherited;
  let text: string;
  try {
    const read = await io.readFile(file, {
      maxBytes: GITIGNORE_BYTES,
      overflow: 'truncate',
      signal,
    });
    if (read.bytes.includes(0)) return inherited;
    text = Buffer.from(read.bytes).toString('utf8');
  } catch (error) {
    signal?.throwIfAborted();
    const code = errorCode(error);
    if (code === 'io_aborted' || code === 'runtime_disposed') throw error;
    return inherited;
  }
  const layer = parseGitignore(directory, text);
  return layer ? [...inherited, layer] : inherited;
}
