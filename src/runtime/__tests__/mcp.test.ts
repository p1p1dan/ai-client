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
import type { RuntimeChildProcess } from '../contracts.ts';
import { MAX_MESSAGE_BYTES, McpClient } from '../plugins/mcp/client.ts';
import {
  loadMcpConfig,
  MAX_SERVERS,
  type McpConfigSource,
  mcpConfigFiles,
} from '../plugins/mcp/config.ts';
import {
  MCP_CONNECT_ALL_TIMEOUT_MS,
  MCP_IMAGE_BYTES,
  MCP_IMAGE_TOTAL_BYTES,
  MCP_OUTPUT_BYTES,
  mcpToolName,
} from '../plugins/mcp/index.ts';
import { neverAsked } from './fixtures/approval.ts';

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
    ).toEqual([
      join('/agent', 'mcp.json'),
      join('/work', '.pi', 'mcp.json'),
      // decision 008 — the local tier rides on the same trust gate, and comes
      // last because last is what wins on a shared server name.
      join('/work', '.pi', 'mcp.local.json'),
    ]);
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

  // skills-mcp-03 — a tool definition rides along with every request, so a
  // character OpenAI or Anthropic rejects in a function name does not break
  // this one tool, it breaks every turn of the session with a 400.
  it('keeps a dot out of a generated tool name', () => {
    expect(mcpToolName('my.server', 'slack.postMessage')).toBe('mcp__my_server__slack_postMessage');
    expect(mcpToolName('a', 'b')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mcpToolName('s.p a/c e', 'x.y:z')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // skills-mcp-07 — merging is "the later file wins", and `disabled` has to
  // obey that too, or turning a server off in the project file leaves the
  // user file's copy of it running.
  it('lets a project file switch off a server the user file enabled', async () => {
    const source = fakeSource({
      [join('/agent', 'mcp.json')]: JSON.stringify({
        mcpServers: { files: { command: 'node', args: ['server.mjs'] } },
      }),
      [join('/work', '.pi', 'mcp.json')]: JSON.stringify({
        mcpServers: { files: { command: 'node', disabled: true } },
      }),
    });
    const { servers } = await loadMcpConfig(source, {
      agentDir: '/agent',
      cwd: '/work',
      projectTrusted: true,
    });
    expect(servers).toEqual([]);
  });

  // skills-mcp-21 — which servers survive the cap must follow what the user
  // wrote, not how the names happen to sort.
  it('drops servers past the cap by declaration order, and names the casualties', async () => {
    const declared = ['zulu', 'yankee', 'xray', ...Array.from({ length: 15 }, (_, i) => `s${i}`)];
    const source = fakeSource({
      [join('/agent', 'mcp.json')]: JSON.stringify({
        mcpServers: Object.fromEntries(declared.map((name) => [name, { command: 'node' }])),
      }),
    });
    const { servers, diagnostics } = await loadMcpConfig(source, { agentDir: '/agent' });
    expect(servers.map((item) => item.name)).toEqual(declared.slice(0, MAX_SERVERS));
    expect(diagnostics[0].message).toContain('s13, s14');
  });
});

/**
 * T018 — the wire, driven byte by byte.
 *
 * A real pipe decides its own chunk boundaries, so the one thing that matters
 * here — what happens when a frame is cut in the middle of a character, or
 * never ends at all — cannot be arranged with a real server. Everything that
 * needs a specific byte at a specific moment lives in this block; everything
 * else stays end-to-end below.
 */
function fakeChild(): {
  child: RuntimeChildProcess;
  sent: string[];
  killed: () => boolean;
} {
  const sent: string[] = [];
  let killed = false;
  let finish: (value: { exitCode: number | null; signal: string | null }) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    finish = resolve;
  });
  return {
    child: {
      write: async (bytes) => {
        sent.push(Buffer.from(bytes).toString('utf8').trim());
      },
      exited,
      kill: async () => {
        killed = true;
        finish({ exitCode: null, signal: 'SIGTERM' });
      },
    },
    sent,
    killed: () => killed,
  };
}

describe('T018 framing and protocol on the wire', () => {
  // skills-mcp-04 — decoding each stdout chunk on its own turned any character
  // straddling a chunk boundary into two replacement characters, which JSON
  // parses happily, so the corruption reached the model with no diagnostic.
  it('decodes a character split across two stdout chunks', async () => {
    const { child } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 2000 });
    const text = '结果：一段中文，带 emoji 🚀，还有更多内容。';
    const pending = client.callTool('echo', {});
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n`,
      'utf8'
    );
    // Cut on a UTF-8 continuation byte: the halves are not characters.
    let cut = Math.floor(frame.length / 2);
    while ((frame[cut] & 0xc0) !== 0x80) cut += 1;
    client.receive(frame.subarray(0, cut));
    client.receive(frame.subarray(cut));
    const result = await pending;
    expect(result.content[0].text).toBe(text);
    expect(result.content[0].text).not.toContain('�');
  });

  // skills-mcp-14 — the cap is documented in bytes and was measured in UTF-16
  // units, so CJK output got a third of the stated budget; and the runaway
  // server that tripped it was left running, still writing into the pipe.
  it('caps a frame by bytes, not characters, and kills the server that overran it', async () => {
    const { child, killed } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 2000 });
    const pending = client.callTool('echo', {});
    // 9 MB of three-byte characters: over the byte cap, under it in UTF-16
    // units, and never terminated by a newline.
    const chunk = Buffer.from('世'.repeat(300_000), 'utf8');
    expect(chunk.length * 10).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(300_000 * 10).toBeLessThan(MAX_MESSAGE_BYTES);
    for (let i = 0; i < 10; i += 1) client.receive(chunk);
    await expect(pending).rejects.toThrow(/exceeded/);
    expect(killed()).toBe(true);
  });

  // skills-mcp-16 — the file header promises an honest "method not found";
  // the code dropped the request, leaving a server waiting on a reply that was
  // never coming.
  it('answers a request it does not implement instead of going quiet', () => {
    const { child, sent } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 2000 });
    client.receive(
      Buffer.from(
        `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage' })}\n`,
        'utf8'
      )
    );
    expect(JSON.parse(sent[0])).toMatchObject({
      id: 7,
      error: { code: -32601, message: expect.stringContaining('sampling/createMessage') },
    });
  });

  it('still ignores a notification, which has no id to answer', () => {
    const { child, sent } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 2000 });
    client.receive(
      Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x' })}\n`, 'utf8')
    );
    expect(sent).toEqual([]);
  });

  // skills-mcp-06 — Stop left the call hanging on the 120s budget and the
  // server working on an answer nobody would read.
  it('returns at once on abort and tells the server the request is cancelled', async () => {
    const { child, sent } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 120_000 });
    const controller = new AbortController();
    const pending = client.callTool('slow', {}, controller.signal);
    controller.abort();
    // The caller's own reason survives, so a stopped turn reports the stop.
    await expect(pending).rejects.toThrow(/aborted/);
    expect(JSON.parse(sent[1])).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    });
  });

  it('rejects a call whose signal was already aborted without writing anything', async () => {
    const { child, sent } = fakeChild();
    const client = new McpClient({ child, timeoutMs: 120_000 });
    await expect(
      client.callTool('slow', {}, AbortSignal.abort(new Error('stopped by the user')))
    ).rejects.toThrow('stopped by the user');
    expect(sent).toEqual([]);
  });

  // skills-mcp-01 — the phase budget has to stay under the one Main is holding
  // a timer against (`BOOTSTRAP_REQUEST_TIMEOUT_MS`, 60s in
  // `src/main/services/agent-host/createPiWorkerSlot.ts`), or a slow server
  // fails the session instead of just itself.
  it('keeps the whole connect phase under the bootstrap RPC limit', () => {
    expect(MCP_CONNECT_ALL_TIMEOUT_MS).toBeLessThan(60_000);
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
      mcp: { connectTimeoutMs: 15_000 },
      ...options,
      // `auto` so the gate resolves without a card; the gate itself has its own
      // assertion below.
      permissions: { approve: neverAsked, ...(options.permissions ?? { gear: 'auto' }) },
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
    expect(handle.mcp?.connections[0].tools.map((tool) => tool.name)).toEqual([
      'echo',
      'fail',
      'shot',
    ]);
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
    // skills-mcp-14 — the connection record used to keep reading as healthy,
    // tools and all, after the process behind it was gone.
    expect(handle.mcp?.connections[0].error).toContain('exited');
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

  // skills-mcp-01 — `tools/list` ran on the 120s CALL budget, and the connect
  // phase had no ceiling of its own, so one server that answers `initialize`
  // and then stalls could outlast Main's 60s bootstrap RPC and fail the
  // session's creation with an error that never mentions MCP.
  it('gives up on a server stuck in tools/list and still opens the session', async () => {
    await declare(['--slow-list']);
    const started = Date.now();
    const { handle, faux } = await runtime({
      mcp: { connectTimeoutMs: 20_000, connectAllTimeoutMs: 800 },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(handle.mcp?.connections[0].error).toContain('connect budget');
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain(
      'mcp__echo__echo'
    );
    faux.setResponses([fauxAssistantMessage('fine')]);
    await expect(handle.run({ prompt: 'hi' })).resolves.toMatchObject({ success: true });
  }, 30_000);

  // skills-mcp-01, the other half: cataloguing a server is part of starting it,
  // so `tools/list` answers to the connect budget. It used to be switched to
  // the call budget the moment the handshake ended, one line before the call.
  it('runs tools/list on the connect budget, not the two-minute call budget', async () => {
    await declare(['--slow-list']);
    const { handle } = await runtime({
      mcp: { connectTimeoutMs: 600, connectAllTimeoutMs: 4000 },
    });
    expect(handle.mcp?.connections[0].error).toContain('tools/list did not answer in 600ms');
  }, 30_000);

  // skills-mcp-02 — a repeated tool across pages, or two names that clamp to
  // one, reached `runtimeTools.register`, which throws `duplicate_tool` from a
  // service constructor; that took the whole session's bootstrap with it.
  it('survives a server that offers the same tool twice and two names that clamp alike', async () => {
    await declare(['--dupes']);
    const { handle, faux } = await runtime();
    const connection = handle.mcp?.connections[0];
    expect(connection?.error).toBeUndefined();
    // `echo` came back on both pages and is kept once...
    expect(connection?.tools.filter((tool) => tool.name === 'echo')).toHaveLength(1);
    // ...while the pair that only collides after clamping is reported per tool.
    expect(connection?.toolErrors).toHaveLength(1);
    expect(connection?.toolErrors?.[0]).toContain('duplicate_tool');
    const names = handle.ctx.runtimeTools.list().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('mcp__echo__z'))).toHaveLength(1);
    expect(names).toContain('mcp__echo__echo');
    faux.setResponses([call('mcp__echo__echo', { text: 'hi' }), fauxAssistantMessage('done')]);
    await expect(handle.run({ prompt: 'use it' })).resolves.toMatchObject({ success: true });
  }, 30_000);

  // skills-mcp-06 — with no signal on the call, Stop left the turn waiting out
  // the 120s budget and the server working on an answer nobody would read.
  it('stops a hung call when the turn is aborted, and says so to the server', async () => {
    await declare(['--hang-on-call']);
    const logged: string[] = [];
    const { handle, faux } = await runtime({
      mcp: { connectTimeoutMs: 15_000, log: (...args) => logged.push(args.join(' ')) },
    });
    faux.setResponses([call('mcp__echo__echo', { text: 'x' }), fauxAssistantMessage('stopped')]);
    const controller = new AbortController();
    const started = Date.now();
    await handle.run({
      prompt: 'use it',
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool_execution_start' && event.toolName === 'mcp__echo__echo')
          setTimeout(() => controller.abort(), 50);
      },
    });
    // The per-call budget is two minutes; the point is not waiting it out.
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect.poll(() => logged.join('\n'), { timeout: 3000 }).toContain('[fixture] cancelled');
  }, 30_000);

  // skills-mcp-16 — end to end this time: a server that asks the client for
  // something gets an answer rather than silence.
  it('tells a server asking for sampling that the method is not implemented', async () => {
    await declare(['--ask']);
    const logged: string[] = [];
    await runtime({
      mcp: { connectTimeoutMs: 15_000, log: (...args) => logged.push(args.join(' ')) },
    });
    await expect.poll(() => logged.join('\n'), { timeout: 3000 }).toContain('[fixture] refused');
  }, 30_000);

  // skills-mcp-05 — a screenshot server is one of the most common MCP servers
  // there is, and every image it returned reached the model as the literal
  // text `[image]`.
  it('forwards an image the server returned as an image block', async () => {
    await declare();
    const { handle, faux } = await runtime();
    faux.setResponses([call('mcp__echo__shot', {}), fauxAssistantMessage('seen')]);
    let content: { type: string; text?: string; data?: string; mimeType?: string }[] = [];
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__shot')
          content = event.result.content as typeof content;
      },
    });
    expect(content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(content[0].text).toBe('here is the page');
    expect(content[1]).toMatchObject({ mimeType: 'image/png' });
    expect(content[1].data?.startsWith('iVBORw0KGgo')).toBe(true);
  }, 30_000);

  // Images skip the text budget entirely, so the count is what is capped — and
  // the text block is never left empty, because the transcript renders it and
  // a JSON dump of a base64 payload is not a transcript line.
  it('caps how many images it forwards and always leaves a readable text block', async () => {
    await declare();
    const { handle, faux } = await runtime();
    const parts = async (args: Record<string, unknown>) => {
      faux.setResponses([call('mcp__echo__shot', args), fauxAssistantMessage('seen')]);
      let content: { type: string; text?: string }[] = [];
      await handle.run({
        prompt: 'use it',
        onEvent: (event) => {
          if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__shot')
            content = event.result.content as typeof content;
        },
      });
      return content;
    };
    const many = await parts({ count: 10, silent: true });
    expect(many.filter((part) => part.type === 'image')).toHaveLength(8);
    expect(many[0].text).toContain('2 more image(s) not forwarded');
    const one = await parts({ count: 1, silent: true });
    expect(one.map((part) => part.type)).toEqual(['text', 'image']);
    expect(one[0].text).toBe('(1 image)');
  }, 30_000);

  /**
   * T024 — a server's answer is the one thing written into the session file
   * whose size neither the user nor the model chose.
   *
   * The count cap said nothing about bytes, so eight images bounded only by the
   * 8 MiB transport frame could land in one JSONL line, and the 32 MiB session
   * budget is a hard wall: once the file is over it, the session cannot be
   * opened again at all.
   */
  it('drops an image that is over the per-image byte budget and says why', async () => {
    await declare();
    const { handle, faux } = await runtime();
    faux.setResponses([
      call('mcp__echo__shot', { count: 1, silent: true, bytes: MCP_IMAGE_BYTES + 1 }),
      fauxAssistantMessage('seen'),
    ]);
    let content: { type: string; text?: string }[] = [];
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__shot')
          content = event.result.content as typeof content;
      },
    });
    expect(content.filter((part) => part.type === 'image')).toHaveLength(0);
    // "Too many" and "too large" are different instructions to the model.
    expect(content[0].text).toContain('1 image(s) dropped: over the size budget');
    expect(content[0].text).not.toContain('not forwarded');
  }, 30_000);

  it('stops forwarding images once the per-call byte budget is spent', async () => {
    await declare();
    const { handle, faux } = await runtime();
    // Each one fits on its own; three of them do not fit together, which is
    // exactly what a per-image ceiling alone would have let through.
    const each = Math.floor(MCP_IMAGE_TOTAL_BYTES / 2) - 1;
    faux.setResponses([
      call('mcp__echo__shot', { count: 3, silent: true, bytes: each }),
      fauxAssistantMessage('seen'),
    ]);
    let content: { type: string; text?: string; data?: string }[] = [];
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__shot')
          content = event.result.content as typeof content;
      },
    });
    const images = content.filter((part) => part.type === 'image');
    expect(images).toHaveLength(2);
    expect(images.reduce((sum, part) => sum + (part.data?.length ?? 0), 0)).toBeLessThanOrEqual(
      MCP_IMAGE_TOTAL_BYTES
    );
    expect(content[0].text).toContain('1 image(s) dropped: over the size budget');
  }, 30_000);

  /**
   * T024 — the budget is named in bytes and the session file is measured in
   * bytes, but the check counted UTF-16 units: the same 50 KiB admitted three
   * times that much CJK text, and nothing downstream cut it again.
   */
  it('measures the text budget in bytes, not UTF-16 units', async () => {
    await declare();
    const { handle, faux } = await runtime();
    // Under the old ceiling by `length`, well over it by bytes.
    const text = '\u6c49'.repeat(MCP_OUTPUT_BYTES / 2);
    faux.setResponses([call('mcp__echo__echo', { text }), fauxAssistantMessage('seen')]);
    let content: { type: string; text?: string }[] = [];
    await handle.run({
      prompt: 'use it',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'mcp__echo__echo')
          content = event.result.content as typeof content;
      },
    });
    const returned = content[0].text ?? '';
    expect(returned).toContain('[output truncated]');
    expect(Buffer.byteLength(returned)).toBeLessThanOrEqual(MCP_OUTPUT_BYTES + 32);
    // Cut on a character boundary: no replacement character at the seam.
    expect(returned).not.toContain('\ufffd');
  }, 30_000);

  // skills-mcp-15 — a failed spawn left `client` undefined behind a cast that
  // said otherwise, so any later reader of `connections` would dereference a
  // client that was never built.
  it('records a server that could not be started without inventing a client for it', async () => {
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { ghost: { command: join(dir, 'no-such-binary') } } })
    );
    const { handle, faux } = await runtime();
    const connection = handle.mcp?.connections[0];
    expect(connection?.error).toBeTruthy();
    expect(connection?.client).toBeUndefined();
    faux.setResponses([fauxAssistantMessage('fine')]);
    await expect(handle.run({ prompt: 'hi' })).resolves.toMatchObject({ success: true });
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
    const exited = connection?.client?.exited;
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
