/**
 * P5-3 gate — the MCP bridge, against a real server over real pipes.
 *
 * The fixture in `fixtures/mcp-echo-server.mjs` is an actual stdio MCP server
 * started through `runtimeExec.spawn`, not a mocked transport. That is the
 * point: ARD D11 says compatibility is a property of the PROCESS that runs, so
 * a test that stubbed the transport would prove the client's bookkeeping and
 * say nothing about the one thing the bridge had to be built around.
 *
 * The config half is tested separately against an in-memory source, because
 * every one of its failure modes is silent — a server with no `command`, an
 * untrusted project naming a program to execute, a name that cannot appear in
 * a tool name. None of those throws; they just make a server not exist.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { loadMcpConfig, type McpConfigSource, mcpConfigFiles } from '../plugins/mcp/config.ts';
import { mcpToolName } from '../plugins/mcp/index.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-echo-server.mjs');

function fakeSource(files: Record<string, string>): McpConfigSource {
  return {
    async readText(path) {
      return files[path];
    },
  };
}

describe('P5-3 server declarations', () => {
  it('withholds the project file until the folder is trusted', () => {
    expect(mcpConfigFiles({ agentDir: '/agent', cwd: '/work' }).map((item) => item.path)).toEqual([
      join('/agent', 'mcp.json'),
    ]);
    expect(
      mcpConfigFiles({ agentDir: '/agent', cwd: '/work', projectTrusted: true }).map(
        (item) => item.path
      )
    ).toEqual([join('/agent', 'mcp.json'), join('/work', '.pi', 'mcp.json')]);
  });

  it('reads the ecosystem file shape and lets a project override a user server', async () => {
    const source = fakeSource({
      [join('/agent', 'mcp.json')]: JSON.stringify({
        mcpServers: {
          files: { command: 'node', args: ['server.mjs'], env: { TOKEN: 'a' } },
          off: { command: 'node', disabled: true },
        },
      }),
      [join('/work', '.pi', 'mcp.json')]: JSON.stringify({
        mcpServers: { files: { command: 'node', args: ['project.mjs'] } },
      }),
    });
    const { servers } = await loadMcpConfig(source, {
      agentDir: '/agent',
      cwd: '/work',
      projectTrusted: true,
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'files',
      command: 'node',
      args: ['project.mjs'],
      scope: 'project',
    });
  });

  it('never reads the project file for an untrusted folder', async () => {
    const read: string[] = [];
    const source: McpConfigSource = {
      async readText(path) {
        read.push(path);
        return undefined;
      },
    };
    await loadMcpConfig(source, { agentDir: '/agent', cwd: '/work' });
    // Not merely "ignored": an MCP entry names a program to execute, so an
    // untrusted checkout's file must not even be opened.
    expect(read).toEqual([join('/agent', 'mcp.json')]);
  });

  it('says why an entry was dropped instead of coming up short in silence', async () => {
    const source = fakeSource({
      [join('/agent', 'mcp.json')]: JSON.stringify({
        mcpServers: {
          remote: { type: 'http', url: 'https://example.test/mcp' },
          nameless: { args: ['x'] },
          'bad name': { command: 'node' },
        },
      }),
    });
    const { servers, diagnostics } = await loadMcpConfig(source, { agentDir: '/agent' });
    expect(servers).toEqual([]);
    expect(diagnostics.map((item) => item.message)).toEqual([
      'server "remote" is an HTTP/SSE server; this bridge speaks stdio only',
      'server "nameless" has no "command"',
      'server name "bad name" is not usable in a tool name',
    ]);
  });

  it('reports malformed JSON rather than throwing a session away', async () => {
    const source = fakeSource({ [join('/agent', 'mcp.json')]: '{ not json' });
    const { servers, diagnostics } = await loadMcpConfig(source, { agentDir: '/agent' });
    expect(servers).toEqual([]);
    expect(diagnostics[0].code).toBe('parse_failed');
  });

  it('keeps two servers with the same tool name apart', () => {
    expect(mcpToolName('files', 'search')).toBe('mcp__files__search');
    expect(mcpToolName('web', 'search')).toBe('mcp__web__search');
    expect(mcpToolName('a b/c', 'x:y')).toBe('mcp__a_b_c__x_y');
    expect(mcpToolName('s'.repeat(60), 't'.repeat(60)).length).toBe(64);
  });
});

describe('P5-3 bridge against a real stdio server', () => {
  let dir: string;
  let root: string;
  let agentDir: string;
  const runtimes: RuntimeHandle[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-mcp-'));
    root = join(dir, 'project');
    agentDir = join(dir, 'agent');
    await mkdir(root, { recursive: true });
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    for (const handle of runtimes.splice(0)) await handle.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function declare(args: string[] = []) {
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [FIXTURE, ...args] } },
      })
    );
  }

  /** T002 — writes a global policy override, same location `shellPolicy.test.ts` uses. */
  async function policy(document: unknown) {
    const path = join(agentDir, 'extensions', 'pi-permission-system', 'config.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(document));
  }

  async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', contextWindow: 128_000 }],
    });
    const handle = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      tools: { cwd: root },
      agentDir,
      // `auto` so the gate resolves without a card; the gate itself has its own
      // assertion below.
      permissions: { gear: 'auto' },
      mcp: { connectTimeoutMs: 15_000 },
      ...options,
    });
    runtimes.push(handle);
    return { handle, faux };
  }

  function call(name: string, args: Record<string, unknown>) {
    const message = fauxAssistantMessage('');
    message.content = [{ type: 'toolCall', id: 'c1', name, arguments: args }];
    message.stopReason = 'toolUse';
    return message;
  }

  it('starts the server, lists its tools, and calls one end to end', async () => {
    await declare();
    const { handle, faux } = await runtime();
    expect(handle.mcp?.connections).toHaveLength(1);
    expect(handle.mcp?.connections[0].error).toBeUndefined();
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).toContain('mcp__echo__echo');

    faux.setResponses([call('mcp__echo__echo', { text: 'hello' }), fauxAssistantMessage('done')]);
    const texts: string[] = [];
    const result = await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo') {
          expect(event.isError).toBeFalsy();
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(texts.join('\n')).toBe('echo: hello');
  }, 30_000);

  it('survives a server that writes non-JSON to stdout before answering', async () => {
    await declare(['--noisy']);
    const { handle } = await runtime();
    // A banner on stdout is common and is not a protocol violation worth
    // dropping the connection over.
    expect(handle.mcp?.connections[0].error).toBeUndefined();
    expect(handle.mcp?.connections[0].tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
  }, 30_000);

  it('follows tools/list pagination', async () => {
    await declare(['--paged']);
    const { handle } = await runtime();
    expect(handle.mcp?.connections[0].tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
  }, 30_000);

  it("passes a server's own tool error to the model instead of failing the turn", async () => {
    await declare();
    const { handle, faux } = await runtime();
    faux.setResponses([call('mcp__echo__fail', {}), fauxAssistantMessage('noted')]);
    const texts: string[] = [];
    let errored: boolean | undefined;
    const result = await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__fail') {
          errored = event.isError;
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    // The SERVER said the tool failed. That is something the model reads and
    // reacts to, not a runtime fault that should end the turn.
    expect(errored).toBeFalsy();
    expect(texts.join('\n')).toContain('the thing went wrong');
    expect(texts.join('\n')).toContain('[tool reported an error]');
  }, 30_000);

  it('reports a server that never finishes its handshake, and keeps the session usable', async () => {
    await declare(['--silent']);
    const { handle, faux } = await runtime({ mcp: { connectTimeoutMs: 1500 } });
    expect(handle.mcp?.connections[0].error).toContain('initialize');
    // No tool from a server that never introduced itself...
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain(
      'mcp__echo__echo'
    );
    // ...and the rest of the session still works.
    faux.setResponses([fauxAssistantMessage('fine')]);
    await expect(handle.run({ prompt: 'hi' })).resolves.toMatchObject({ success: true });
  }, 30_000);

  it('turns a mid-call crash into a tool error, not a dead session', async () => {
    await declare(['--crash-on-call']);
    const { handle, faux } = await runtime();
    faux.setResponses([call('mcp__echo__echo', { text: 'x' }), fauxAssistantMessage('recovered')]);
    let errored = false;
    const result = await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo')
          errored = event.isError;
      },
    });
    expect(errored).toBe(true);
    expect(result.success).toBe(true);
  }, 30_000);

  it('asks the permission gate before the call reaches the server', async () => {
    await declare();
    const asked: string[] = [];
    const { handle, faux } = await runtime({
      permissions: {
        gear: 'ask',
        approve: async (request) => {
          asked.push(request.tool);
          return 'deny';
        },
      },
    });
    faux.setResponses([call('mcp__echo__echo', { text: 'hello' }), fauxAssistantMessage('ok')]);
    let errored = false;
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo')
          errored = event.isError;
      },
    });
    // An MCP tool can do anything its server can do and has nothing local to
    // inspect, so it must not inherit the trust granted to local edits.
    expect(asked).toEqual(['mcp__echo__echo']);
    expect(errored).toBe(true);
  }, 30_000);

  // T002/permissions-09/skills-mcp-12 — `mcp/index.ts` passed `request.tool`
  // (the sanitized `mcp__<server>__<tool>` name) as the policy surface, which
  // never equals the ecosystem's `mcp` surface key, so a written `mcp` rule —
  // including a `deny` — was silently never consulted and `auto` allowed the
  // call regardless of it.
  it('lets an mcp deny policy rule actually block a call under auto', async () => {
    await declare();
    await policy({ permission: { mcp: 'deny' } });
    const { handle, faux } = await runtime({ permissions: { gear: 'auto' } });
    faux.setResponses([call('mcp__echo__echo', { text: 'hello' }), fauxAssistantMessage('ok')]);
    let errored = false;
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo')
          errored = event.isError;
      },
    });
    expect(errored).toBe(true);
  }, 30_000);

  it("matches an mcp policy rule by server:tool, the ecosystem's own shape", async () => {
    await declare();
    // Only this server's `echo` tool is denied; the catch-all stays `ask`
    // which `auto` would otherwise clear, so a pass here proves the specific
    // pattern was consulted, not just the surface's presence.
    await policy({ permission: { mcp: { '*': 'ask', 'echo:echo': 'deny' } } });
    const { handle, faux } = await runtime({ permissions: { gear: 'auto' } });
    faux.setResponses([call('mcp__echo__echo', { text: 'hello' }), fauxAssistantMessage('ok')]);
    let errored = false;
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo')
          errored = event.isError;
      },
    });
    expect(errored).toBe(true);
  }, 30_000);

  it('starts nothing at all when the bridge is not configured', async () => {
    await declare();
    const { handle } = await runtime({ mcp: undefined });
    expect(handle.mcp).toBeUndefined();
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain(
      'mcp__echo__echo'
    );
  }, 30_000);

  it('shuts the server down on dispose', async () => {
    await declare();
    const { handle } = await runtime();
    const connection = handle.mcp?.connections[0];
    expect(connection?.error).toBeUndefined();
    const exited = connection?.client.exited;
    await handle.dispose();
    runtimes.length = 0;
    // The child's own exit is the proof it is gone, not merely forgotten. An
    // orphaned MCP server keeps the whole worker process alive.
    await expect(
      Promise.race([
        exited?.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 5000)),
      ])
    ).resolves.toBe('exited');
  }, 30_000);
});
