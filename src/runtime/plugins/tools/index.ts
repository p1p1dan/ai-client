import { homedir } from 'node:os';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import { type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import { EXEC_SERVICE, HOST_IO_SERVICE, type RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { type BashAnalysis, BashAnalyzer } from '../permissions/bash-analysis.ts';
import { containsPath, PERMISSIONS_SERVICE, pathPolicy } from '../permissions/index.ts';
import { canonicalPath } from './paths.ts';
import { readLines } from './read-lines.ts';

export const TOOLS_SERVICE = 'runtimeTools';
export const TOOL_OUTPUT_BYTES = 50 * 1024;
const FILE_EDIT_BYTES = 8 * 1024 * 1024;
const SEARCH_FILE_BYTES = 1024 * 1024;
const SEARCH_ENTRIES = 20_000;
export interface ToolsConfig {
  cwd: string;
  shellPath?: string;
  shellEnv?: Record<string, string>;
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
      const parts = path.split(sep);
      const wildcard = parts.findIndex((part) => /[*?[]/.test(part));
      if (wildcard < 0) return check(path);
      const parent = parts.slice(0, wildcard).join(sep) || sep;
      await check(parent);
      // Even an unmatched pattern can target denied names after another command creates them.
      if (pathPolicy(path) === 'deny')
        throw new RuntimeHostError('tool_denied', `shell pattern is denied: ${path}`);
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
    };
    for (const path of analysis.paths) await expand(path);
    return { ...analysis, paths: [...paths].sort() };
  }
  private install(): void {
    const io = this.ctx.runtimeHostIo;
    const path = Type.String({ minLength: 1 });
    const objectOptions = { additionalProperties: false };
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
          await io.mkdir(dirname(target), { recursive: true });
          await io.writeFile(target, Buffer.from(args.content));
          return result(`Wrote ${Buffer.byteLength(args.content)} bytes to ${target}`, {
            path: target,
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
          let content = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes);
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
          return result(`Applied ${args.edits.length} edits to ${target}`, { path: target });
        });
      },
    });
    this.register({
      name: 'bash',
      label: 'Bash',
      description:
        'Execute a command with the configured shell in the workspace. Output and runtime are bounded.',
      parameters: Type.Object(
        {
          command: Type.String({ minLength: 1, maxLength: 32768 }),
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
          timeoutMs: args.timeoutMs ?? 120_000,
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
        'Search for literal text in UTF-8 files. Skips symlinks, .git, node_modules, binary files and denied paths; bounded to 1 MiB per file.',
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 1024 }),
          path: Type.Optional(path),
          include: Type.Optional(Type.String({ maxLength: 512 })),
          caseInsensitive: Type.Optional(Type.Boolean()),
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
            if ((args.caseInsensitive ? lines[line].toLowerCase() : lines[line]).includes(needle)) {
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
    for await (const entry of io.readDirectory(directory)) {
      signal?.throwIfAborted();
      if (++budget.visited > SEARCH_ENTRIES) {
        budget.truncated = true;
        return;
      }
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (!allowed(path)) continue;
      const canonical = await io.realpath(path);
      if (!containsPath(root, canonical) || canonical !== path) continue;
      if (entry.kind === 'directory') stack.push(path);
      else if (entry.kind === 'file') yield path;
    }
  }
}
