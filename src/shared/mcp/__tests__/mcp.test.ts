/**
 * P5-3 gate, the pure half — MCP server declarations, tool naming and the
 * JSON-RPC wire.
 *
 * Moved from `src/runtime/__tests__/mcp.test.ts` (dsh-rebase P1-16 prep) with
 * the library it pins; the case bodies are unchanged, only the imports point
 * at `src/shared/mcp` and the fake child is typed against the library's own
 * port. The runtime keeps the end-to-end half, which starts the real stdio
 * fixture through `runtimeExec.spawn`, because ARD D11 makes compatibility a
 * property of the PROCESS that runs.
 *
 * The config half runs against an in-memory source, because every one of its
 * failure modes is silent — a server with no `command`, an untrusted project
 * naming a program to execute, a name that cannot appear in a tool name. None
 * of those throws; they just make a server not exist.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, type McpChildProcess, McpClient } from '../client.ts';
import {
  hostServerBudget,
  loadMcpConfig,
  MAX_SERVERS,
  type McpConfigSource,
  mcpConfigFiles,
  sessionServerBudget,
  workerSlotBudget,
} from '../config.ts';
import { MCP_CONNECT_ALL_TIMEOUT_MS } from '../connect.ts';
import { mcpToolName } from '../naming.ts';

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
    // `maxServers` pinned: the default is now derived from this machine's RAM
    // (concurrency-04), and a case about declaration ORDER must not depend on
    // how much memory the box running it happens to have.
    const { servers, diagnostics } = await loadMcpConfig(source, {
      agentDir: '/agent',
      maxServers: MAX_SERVERS,
    });
    expect(servers.map((item) => item.name)).toEqual(declared.slice(0, MAX_SERVERS));
    expect(diagnostics[0].message).toContain('s13, s14');
  });

  /**
   * concurrency-04 — the number that was never accounted for is a PRODUCT.
   *
   * Each session is its own worker process and starts its own copy of every
   * configured server, so a per-session cap of 16 on a machine allowed three
   * sessions is 48 live child processes that no part of the application counts.
   */
  describe('machine-wide process budget', () => {
    const GIB = 1024 ** 3;

    it('mirrors the worker memory tiers that decide how many sessions may run', () => {
      // MIRROR of resolveDefaultWorkerCapacity (main-process WorkerManager);
      // these three numbers are the contract between the two files.
      expect(workerSlotBudget(3.3 * GIB)).toBe(3);
      expect(workerSlotBudget(8 * GIB)).toBe(6);
      expect(workerSlotBudget(32 * GIB)).toBe(10);
    });

    it('keeps the machine-wide total bounded on every tier', () => {
      expect(sessionServerBudget(3.3 * GIB)).toBe(4);
      expect(sessionServerBudget(8 * GIB)).toBe(6);
      expect(sessionServerBudget(32 * GIB)).toBe(12);
      expect(hostServerBudget(3.3 * GIB)).toBe(12);
      expect(hostServerBudget(8 * GIB)).toBe(36);
      expect(hostServerBudget(32 * GIB)).toBe(120);
      // The point of the budget: never the old 16 × slots.
      for (const memory of [3.3 * GIB, 8 * GIB, 32 * GIB])
        expect(hostServerBudget(memory)).toBeLessThan(MAX_SERVERS * workerSlotBudget(memory));
    });

    it('drops the servers past this session share and says why', async () => {
      const declared = Array.from({ length: 9 }, (_, index) => `s${index}`);
      const source = fakeSource({
        [join('/agent', 'mcp.json')]: JSON.stringify({
          mcpServers: Object.fromEntries(declared.map((name) => [name, { command: 'node' }])),
        }),
      });
      const { servers, diagnostics } = await loadMcpConfig(source, {
        agentDir: '/agent',
        maxServers: sessionServerBudget(3.3 * GIB),
      });
      expect(servers.map((item) => item.name)).toEqual(['s0', 's1', 's2', 's3']);
      expect(diagnostics[0].message).toContain('only the first 4 servers');
      expect(diagnostics[0].message).toContain('every open session starts its own copy');
    });
  });
});

/**
 * T018 — the wire, driven byte by byte.
 *
 * A real pipe decides its own chunk boundaries, so the one thing that matters
 * here — what happens when a frame is cut in the middle of a character, or
 * never ends at all — cannot be arranged with a real server. Everything that
 * needs a specific byte at a specific moment lives in this block; everything
 * else stays end-to-end, against a real server, in the runtime's `mcp.test.ts`.
 */
function fakeChild(): {
  child: McpChildProcess;
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
