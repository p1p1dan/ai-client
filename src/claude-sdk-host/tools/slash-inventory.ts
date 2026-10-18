/**
 * dsh-rebase decision 194 (ruling 193 item 29): what the bundled CLI lists and runs as
 * slash commands under the options the SDK host uses (streaming input, settingSources
 * user + project + local, trusted project, app-private CLAUDE_CONFIG_DIR).
 *
 * Usage: node tools/slash-inventory.ts <gatewayUrl> [--out file.json] [--only a,b] [--jobs N]
 * The gateway is the local fake one (`fake-gateway.mjs --plan claude-sdk`).
 *
 * In fresh temporary directories it lays out a user layer (the config dir), a project
 * (`.claude/commands`, `.claude/skills`, a SessionStart hook that writes a marker file, a
 * directory marketplace with one plugin), then:
 *
 * 1. `lister`: starts the CLI with streaming input and sends nothing; reads
 *    `initializationResult().commands` and whether the hook ran; twice, because the CLI
 *    installs a project's plugins from its second start on (README §5);
 * 2. `session`: sends one message and reads `system/init` (`slash_commands`, `skills`,
 *    `plugins`) and `supportedCommands()`;
 * 3. `runs`: each command in its own fresh session, sent as the first message; records
 *    the message kinds it produced, any `local_command_output`, whether a model request
 *    was made and the result. Skills and custom commands are sent with `CC-ECHO` as their
 *    argument, so the reply names the CANARY words of their bodies that reached the model.
 *
 * Prints one JSON document (and writes it with --out). Exits 1 only on a setup failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const argv = process.argv.slice(2);
const gatewayUrl = argv[0];
if (!gatewayUrl)
  throw new Error('usage: slash-inventory.ts <gatewayUrl> [--out f] [--only a,b] [--jobs N]');
let out: string | undefined;
let only: string[] | undefined;
let jobs = 4;
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--out') out = argv[++i];
  else if (argv[i] === '--only') only = String(argv[++i]).split(',').filter(Boolean);
  else if (argv[i] === '--jobs') jobs = Math.max(1, Number(argv[++i]) || 1);
}

// ---- layout ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'pilab-slash-inv-'));
const configDir = join(base, 'config');
const workspace = join(base, 'repo');
const market = join(base, 'market');
const hookMarker = join(base, 'session-start-hook-ran');

function put(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function skill(name: string, canary: string): string {
  return `---\nname: ${name}\ndescription: Inventory skill ${name}\n---\n\nSay ${canary}.\n`;
}

function command(name: string, canary: string): string {
  return `---\ndescription: Inventory command ${name}\nargument-hint: <words>\n---\n\nSay ${canary} and $ARGUMENTS.\n`;
}

put(join(configDir, 'commands', 'inv-user-cmd.md'), command('inv-user-cmd', 'CANARY-USER-CMD'));
put(
  join(configDir, 'skills', 'inv-user-skill', 'SKILL.md'),
  skill('inv-user-skill', 'CANARY-USER-SKILL')
);
put(
  join(workspace, '.claude', 'commands', 'inv-proj-cmd.md'),
  command('inv-proj-cmd', 'CANARY-PROJ-CMD')
);
put(
  join(workspace, '.claude', 'skills', 'inv-proj-skill', 'SKILL.md'),
  skill('inv-proj-skill', 'CANARY-PROJ-SKILL')
);
// A skill a person may not call (`user-invocable: false`): is it listed?
put(
  join(workspace, '.claude', 'skills', 'inv-model-only', 'SKILL.md'),
  '---\nname: inv-model-only\ndescription: Model-only skill\nuser-invocable: false\n---\n\nSay CANARY-MODEL-ONLY.\n'
);
const pluginRoot = join(market, 'plugins', 'inv-plugin');
put(
  join(market, '.claude-plugin', 'marketplace.json'),
  JSON.stringify({
    name: 'inv-market',
    owner: { name: 'inventory' },
    plugins: [
      { name: 'inv-plugin', source: './plugins/inv-plugin', description: 'Inventory plugin' },
    ],
  })
);
put(
  join(pluginRoot, '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: 'inv-plugin', version: '0.0.1', description: 'Inventory plugin' })
);
put(
  join(pluginRoot, 'commands', 'inv-plugin-cmd.md'),
  command('inv-plugin-cmd', 'CANARY-PLUGIN-CMD')
);
put(
  join(pluginRoot, 'skills', 'inv-plugin-skill', 'SKILL.md'),
  skill('inv-plugin-skill', 'CANARY-PLUGIN-SKILL')
);
const hookCommand = `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(hookMarker)}`;
put(
  join(workspace, '.claude', 'settings.json'),
  JSON.stringify(
    {
      extraKnownMarketplaces: { 'inv-market': { source: { source: 'directory', path: market } } },
      enabledPlugins: { 'inv-plugin@inv-market': true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand }] }] },
    },
    null,
    2
  )
);
put(join(workspace, 'README.md'), '# inventory repo\n');
spawnSync('git', ['init', '-q'], { cwd: workspace });

// ---- the CLI's options, as the host launches it ----------------------------------------

const KEEP = new Set(
  [
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
    'PATHEXT',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SYSTEMDRIVE',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'LANG',
    'PSMODULEPATH',
  ].map((k) => k.toUpperCase())
);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && KEEP.has(k.toUpperCase())) env[k] = v;
Object.assign(env, {
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: gatewayUrl,
  ANTHROPIC_API_KEY: 'sk-fake-inventory-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'pilab-slash-inventory/0',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
});

function options(extra: Record<string, unknown> = {}): Options {
  return {
    cwd: workspace,
    env,
    model: 'claude-opus-5-5',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Inventory run.' },
    tools: { type: 'preset', preset: 'claude_code' },
    settings: { attribution: false, skipWebFetchPreflight: true, ...extra } as Options['settings'],
    settingSources: ['user', 'project', 'local'],
    ...({ workspaceTrust: { accepted: true, directory: workspace } } as Partial<Options>),
    strictMcpConfig: true,
    permissionMode: 'default',
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    includePartialMessages: true,
  };
}

class Inbox {
  private queue: SDKUserMessage[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wake?.();
  }
  close(): void {
    this.ended = true;
    this.wake?.();
  }
  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift() as SDKUserMessage;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

interface CommandRow {
  name: string;
  builtin: boolean;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

function rows(commands: unknown): CommandRow[] {
  if (!Array.isArray(commands)) return [];
  return commands.map((c) => {
    const r = c as Record<string, unknown>;
    return {
      name: String(r.name),
      builtin: r.builtin === true,
      description: String(r.description ?? '').slice(0, 160),
      argumentHint: String(r.argumentHint ?? ''),
      ...(Array.isArray(r.aliases) && r.aliases.length > 0
        ? { aliases: r.aliases as string[] }
        : {}),
    };
  });
}

/**
 * Phase 1: start, list, close; nothing sent. `extra` goes to the flag settings (the
 * catalog lister's `disableAllHooks`).
 */
async function lister(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  rmSync(hookMarker, { force: true });
  const inbox = new Inbox();
  const started = Date.now();
  const q = query({ prompt: inbox.stream(), options: options(extra) });
  const pump = (async () => {
    const seen: string[] = [];
    try {
      for await (const m of q) {
        const r = m as unknown as Record<string, unknown>;
        seen.push(`${r.type}${r.subtype ? `/${r.subtype}` : ''}`);
      }
    } catch (error) {
      seen.push(`error ${String(error)}`);
    }
    return seen;
  })();
  const init = await q.initializationResult();
  const listedMs = Date.now() - started;
  const supported = rows(await q.supportedCommands());
  // Which rows are skills: `reloadSkills()` answers the skill list (no message needed).
  const skills = await q.reloadSkills().then(
    (r) => (r as { skills?: unknown }).skills,
    (error: unknown) => `error ${String(error)}`
  );
  // Give a SessionStart hook a moment to show itself if it was started.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const hookRan = existsSync(hookMarker);
  inbox.close();
  q.close();
  const messages = await pump;
  return {
    listedMs,
    hookRan,
    commands: rows(init.commands),
    supportedSameAsInit: JSON.stringify(supported) === JSON.stringify(rows(init.commands)),
    skills: Array.isArray(skills) ? rows(skills).map((c) => c.name) : skills,
    agents: Array.isArray(init.agents) ? init.agents.map((a) => (a as { name: string }).name) : [],
    messagesWithoutSend: messages,
  };
}

interface RunRecord {
  line: string;
  kinds: string[];
  localOutput?: string;
  modelRequests: number;
  assistantText: string;
  assistantShape?: string;
  result?: { subtype: string; isError: boolean; text: string };
  timedOut?: boolean;
  error?: string;
}

/** Phase 2: one message, then the session's view of its commands. */
async function session(): Promise<Record<string, unknown>> {
  const inbox = new Inbox();
  const q = query({ prompt: inbox.stream(), options: options() });
  inbox.push('CC-TEXT hello');
  let init: Record<string, unknown> | undefined;
  let changed: unknown;
  for await (const m of q) {
    const r = m as unknown as Record<string, unknown>;
    if (r.type === 'system' && r.subtype === 'init') init = r;
    if (r.type === 'system' && r.subtype === 'commands_changed') changed = r.commands;
    if (r.type === 'result') break;
  }
  const supported = rows(await q.supportedCommands());
  inbox.close();
  q.close();
  return {
    init: init
      ? {
          slash_commands: init.slash_commands,
          terminal_slash_commands: init.terminal_slash_commands,
          skills: init.skills,
          plugins: init.plugins,
          plugin_errors: init.plugin_errors,
          claude_code_version: init.claude_code_version,
        }
      : null,
    commandsChanged: changed ? rows(changed).map((c) => c.name) : null,
    supported,
  };
}

/** Phase 3: `line` as the first message of a fresh session. */
async function run(line: string): Promise<RunRecord> {
  const inbox = new Inbox();
  const q = query({ prompt: inbox.stream(), options: options() });
  inbox.push(line);
  const record: RunRecord = { line, kinds: [], modelRequests: 0, assistantText: '' };
  const timer = setTimeout(() => {
    record.timedOut = true;
    inbox.close();
    q.close();
  }, 45_000);
  try {
    for await (const m of q as AsyncGenerator<SDKMessage>) {
      const r = m as unknown as Record<string, unknown>;
      if (r.type === 'stream_event') {
        const event = r.event as Record<string, unknown>;
        if (event.type === 'message_start') record.modelRequests += 1;
        continue;
      }
      const kind = `${r.type}${r.subtype ? `/${r.subtype}` : ''}`;
      if (record.kinds.at(-1) !== kind) record.kinds.push(kind);
      if (r.type === 'system' && r.subtype === 'local_command_output') {
        record.localOutput = `${record.localOutput ?? ''}${String(r.content ?? '')}`.slice(0, 600);
      }
      if (r.type === 'assistant') {
        const m = r.message as { model?: unknown; id?: unknown };
        record.assistantShape ??= `model=${String(m?.model)} id=${String(m?.id).slice(0, 12)}`;
        const content = (r.message as { content?: unknown })?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text) record.assistantText += b.text;
          }
        }
      }
      if (r.type === 'user') {
        // A local command's echo and output can arrive as user messages too.
        const content = (r.message as { content?: unknown })?.content;
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        if (/local-command|command-name|command-message/.test(text)) {
          record.localOutput = `${record.localOutput ?? ''}[user] ${text}`.slice(0, 600);
        }
      }
      if (r.type === 'result') {
        record.result = {
          subtype: String(r.subtype),
          isError: r.is_error === true,
          text: String(r.result ?? (r.errors as unknown) ?? '').slice(0, 300),
        };
        break;
      }
    }
  } catch (error) {
    record.error = String(error).slice(0, 300);
  } finally {
    clearTimeout(timer);
    inbox.close();
    try {
      q.close();
    } catch {
      // already closed
    }
  }
  record.assistantText = record.assistantText.slice(0, 300);
  return record;
}

async function pool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    })
  );
  return results;
}

/** Commands not run: they end or replace the process, or wait on a person at a terminal. */
const NOT_RUN = new Set([
  'exit',
  'quit',
  'logout',
  'login',
  'upgrade',
  'vim',
  'terminal-setup',
  'ide',
]);

const first = await lister();
const second = await lister();
// The catalog lister's settings: no hook of the repository runs for a menu.
const noHooks = await lister({ disableAllHooks: true });
const sessionView = await session();
const listed = (second.commands as CommandRow[]).map((c) => c.name);
const targets = (only ?? listed).filter((name) => !NOT_RUN.has(name));
const custom = /^inv-/;
const runs = await pool(targets, jobs, (name) =>
  run(custom.test(name) ? `/${name} CC-ECHO` : `/${name}`)
);
const report = {
  base,
  workspace,
  configDir,
  firstStart: first,
  secondStart: second,
  noHooksStart: noHooks,
  session: sessionView,
  notRun: listed.filter((name) => NOT_RUN.has(name)),
  runs,
};
const text = JSON.stringify(report, null, 2);
if (out) writeFileSync(out, text);
console.log(text);
