import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeSdkCliCandidates } from '../../agent-host/claudeSdkEngine';
import { ClaudePluginService, pluginComponents } from '../ClaudePluginService';
import {
  buildClaudeCliEnvironment,
  type ClaudeCliOutput,
  type ClaudeCliRun,
  createClaudeCliRun,
  parseCliOutcome,
} from '../claudeCli';

const out = (stdout: string, code = 0, stderr = ''): ClaudeCliOutput => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

describe('the CLI result line', () => {
  it('reads the last --json line, and the last line of a success message', () => {
    const result = parseCliOutcome(
      out(
        '{"command":"marketplace-add","outcome":"ok","message":"Cloning…\\nSuccessfully added marketplace: x"}\n'
      )
    );
    expect(result).toEqual({ ok: true, message: 'Successfully added marketplace: x' });
  });

  it('a failure carries the CLI message, whatever the human line after it says', () => {
    const result = parseCliOutcome(
      out(
        '{"command":"install","outcome":"failed","message":"Plugin \\"nope\\" not found"}\n✘ Failed to install\n',
        1
      )
    );
    expect(result).toEqual({ ok: false, message: 'Plugin "nope" not found' });
  });

  it('already in the asked-for state counts as done', () => {
    const line = '{"command":"disable","outcome":"failed","alreadyInGoalState":true}';
    expect(parseCliOutcome(out(line, 1)).ok).toBe(true);
  });

  it('no result line: the exit code and stderr decide', () => {
    expect(parseCliOutcome(out('', 2, 'error: unknown option'))).toEqual({
      ok: false,
      message: 'error: unknown option',
    });
  });
});

describe('the CLI environment', () => {
  it('keeps the allowlist only, points at the user layer and stops self-update', () => {
    const env = buildClaudeCliEnvironment({
      inherited: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'sk-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        GITHUB_TOKEN: 'ghp',
      },
      configDir: '/state/claude',
      proxy: null,
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/state/claude',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(env)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(Object.keys(env)).not.toContain('GITHUB_TOKEN');
  });

  it('lays the product proxy over it, as the host does for its CLI', () => {
    const env = buildClaudeCliEnvironment({
      inherited: { PATH: '/usr/bin' },
      configDir: '/c',
      proxy: { url: 'http://proxy.local:8080', noProxy: 'localhost' },
    });
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080');
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080');
  });
});

describe('what a plugin brings', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cp-components-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('counts skills, commands, agents, hook handlers and MCP servers in the default layout', () => {
    const dir = path.join(root, 'full');
    writeFiles(dir, {
      '.claude-plugin/plugin.json': '{"name":"full"}',
      'skills/one/SKILL.md': '---\nname: one\n---\n',
      'skills/two/SKILL.md': '---\nname: two\n---\n',
      'commands/a.md': '',
      'commands/b.md': '',
      'commands/notes.txt': '',
      'agents/reviewer.md': '',
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'y' },
                { type: 'command', command: 'z' },
              ],
            },
          ],
        },
      }),
      '.mcp.json': JSON.stringify({ github: { type: 'http', url: 'https://x' } }),
    });
    expect(pluginComponents(dir)).toEqual({
      skills: 2,
      commands: 2,
      agents: 1,
      hooks: 3,
      mcpServers: 1,
    });
  });

  it('reads MCP servers and hooks declared in the manifest', () => {
    const dir = path.join(root, 'manifest');
    writeFiles(dir, {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'manifest',
        mcpServers: { a: { command: 'a' }, b: { url: 'https://b' } },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'q' }] }] },
      }),
    });
    expect(pluginComponents(dir)).toMatchObject({ mcpServers: 2, hooks: 1 });
  });

  it('a missing directory brings nothing', () => {
    expect(pluginComponents(path.join(root, 'gone'))).toEqual({
      skills: 0,
      commands: 0,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
    });
  });
});

describe('ClaudePluginService without a CLI', () => {
  const calls: string[][] = [];
  const run: ClaudeCliRun = async (args) => {
    calls.push([...args]);
    return out('{"outcome":"ok","message":"done"}');
  };

  it('refuses ids, names and sources the CLI would read as something else', async () => {
    let changed = 0;
    const service = new ClaudePluginService({
      run,
      configDir: () => '/x',
      onChanged: () => changed++,
    });
    expect(await service.install('--help')).toEqual({ ok: false, error: 'Not a plugin id' });
    expect(await service.install('no-marketplace')).toMatchObject({ ok: false });
    expect(await service.addMarketplace('--scope=project')).toMatchObject({ ok: false });
    expect(await service.removeMarketplace('../x')).toMatchObject({ ok: false });
    expect(await service.removeMcpServer('a b')).toMatchObject({ ok: false });
    expect(
      await service.addMcpServer({
        name: 'web',
        transport: 'http',
        url: 'file:///etc',
        headers: {},
      })
    ).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    expect(changed).toBe(0);
  });

  it('runs one change at a time and says so after each', async () => {
    const order: string[] = [];
    let changed = 0;
    const slow: ClaudeCliRun = async (args) => {
      order.push(`start ${args[2]}`);
      await new Promise((resolve) => setTimeout(resolve, args[2] === 'a@m' ? 30 : 1));
      order.push(`end ${args[2]}`);
      return out('{"outcome":"ok"}');
    };
    const service = new ClaudePluginService({
      run: slow,
      configDir: () => '/x',
      onChanged: () => changed++,
    });
    await Promise.all([service.install('a@m'), service.install('b@m')]);
    expect(order).toEqual(['start a@m', 'end a@m', 'start b@m', 'end b@m']);
    expect(changed).toBe(2);
  });

  it('installs, switches and removes in the user scope only', async () => {
    calls.length = 0;
    const service = new ClaudePluginService({ run, configDir: () => '/x' });
    await service.install('a@m');
    await service.setEnabled('a@m', false);
    await service.uninstall('a@m');
    expect(calls).toEqual([
      ['plugin', 'install', 'a@m', '--scope', 'user', '--json'],
      ['plugin', 'disable', 'a@m', '--scope', 'user', '--json'],
      ['plugin', 'uninstall', 'a@m', '--scope', 'user', '--json'],
    ]);
  });
});

/**
 * The bundled CLI itself, on a marketplace in a local directory (no network): pins the
 * JSON shapes the service reads. Skipped when `src/claude-sdk-host` has no CLI installed.
 */
const modules = path.resolve(__dirname, '../../../../claude-sdk-host/node_modules/@anthropic-ai');
const cli = claudeSdkCliCandidates(modules, process.platform, process.arch, {}).find((file) =>
  existsSync(file)
);

describe.skipIf(!cli)('ClaudePluginService on the bundled CLI', () => {
  let root: string;
  let configDir: string;
  let market: string;
  let repo: string;
  let service: ClaudePluginService;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cp-cli-'));
    configDir = path.join(root, 'config');
    market = path.join(root, 'market');
    repo = path.join(root, 'repo');
    mkdirSync(configDir);
    mkdirSync(repo);
    writeFiles(market, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'local-mk',
        owner: { name: 'probe' },
        plugins: [
          { name: 'demo', source: './plugins/demo', description: 'Demo plugin', version: '1.0.0' },
        ],
      }),
      'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        description: 'Demo plugin',
      }),
      'plugins/demo/skills/hello/SKILL.md': '---\nname: hello\ndescription: say hi\n---\nSay hi.\n',
      'plugins/demo/commands/greet.md': 'Greet.\n',
      'plugins/demo/.mcp.json': JSON.stringify({ echo: { command: 'node', args: ['echo.js'] } }),
    });
    writeFiles(repo, {
      '.mcp.json': JSON.stringify({ mcpServers: { repoTool: { type: 'http', url: 'https://r' } } }),
    });
    service = new ClaudePluginService({
      run: createClaudeCliRun({
        cliPath: () => cli,
        defaultCwd: () => configDir,
        env: () => buildClaudeCliEnvironment({ inherited: process.env, configDir, proxy: null }),
      }),
      configDir: () => configDir,
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('adds a marketplace, lists, installs, switches off and on, and uninstalls', async () => {
    expect(await service.addMarketplace(market)).toEqual({ ok: true });
    const state = await service.state();
    expect(state.error).toBeUndefined();
    expect(state.marketplaces).toEqual([
      { name: 'local-mk', sourceKind: 'directory', source: market },
    ]);

    const available = await service.available();
    expect(available).toEqual([
      expect.objectContaining({
        id: 'demo@local-mk',
        name: 'demo',
        marketplace: 'local-mk',
        installed: false,
      }),
    ]);

    expect(await service.install('demo@local-mk')).toEqual({ ok: true });
    const installed = (await service.state()).plugins;
    expect(installed).toEqual([
      {
        id: 'demo@local-mk',
        name: 'demo',
        marketplace: 'local-mk',
        version: '1.0.0',
        description: 'Demo plugin',
        enabled: true,
        scope: 'user',
        components: { skills: 1, commands: 1, agents: 0, hooks: 0, mcpServers: 1 },
      },
    ]);
    expect((await service.available())[0]?.installed).toBe(true);

    expect(await service.setEnabled('demo@local-mk', false)).toEqual({ ok: true });
    expect((await service.state()).plugins[0]?.enabled).toBe(false);
    expect(await service.setEnabled('demo@local-mk', false)).toEqual({ ok: true });
    expect(await service.setEnabled('demo@local-mk', true)).toEqual({ ok: true });

    expect(await service.uninstall('demo@local-mk')).toEqual({ ok: true });
    expect((await service.state()).plugins).toEqual([]);
    expect(await service.removeMarketplace('local-mk')).toEqual({ ok: true });
  }, 120_000);

  it('a failure comes back with the CLI words', async () => {
    const result = await service.install('nope@nowhere');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/nope/);
    expect(await service.addMarketplace(path.join(root, 'missing'))).toMatchObject({ ok: false });
  }, 60_000);

  it('adds and removes a user MCP server; lists the repository and plugin ones without values', async () => {
    expect(
      await service.addMcpServer({
        name: 'local-tool',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'secret-value' },
      })
    ).toEqual({ ok: true });
    await service.addMarketplace(market);
    await service.install('demo@local-mk');

    const { servers, error } = await service.mcpState(repo);
    expect(error).toBeUndefined();
    expect(servers).toEqual([
      {
        name: 'local-tool',
        origin: 'user',
        transport: 'stdio',
        target: 'node server.js',
        envNames: ['TOKEN'],
        headerNames: [],
      },
      {
        name: 'repoTool',
        origin: 'project',
        transport: 'http',
        target: 'https://r',
        envNames: [],
        headerNames: [],
      },
      {
        name: 'echo',
        origin: 'plugin',
        plugin: 'demo@local-mk',
        transport: 'stdio',
        target: 'node echo.js',
        envNames: [],
        headerNames: [],
      },
    ]);
    expect(JSON.stringify(servers)).not.toContain('secret-value');

    expect(await service.removeMcpServer('local-tool')).toEqual({ ok: true });
    expect((await service.mcpState()).servers.map((s) => s.name)).toEqual(['echo']);
  }, 120_000);
});
