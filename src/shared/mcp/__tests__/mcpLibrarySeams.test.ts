import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../client.ts';
import { loadMcpConfig, type McpConfigFiles, mcpConfigSource } from '../config.ts';
import { connectMcpServers } from '../connect.ts';
import { McpError } from '../errors.ts';
import { mcpArgumentsPreview, mcpPolicyValue, mcpToolName } from '../naming.ts';
import { foldMcpToolResult, MCP_OUTPUT_BYTES } from '../results.ts';
import { scriptedLauncher } from './fixtures/scriptedServer.ts';

/**
 * dsh-rebase P1-16 prep — the seams a host plugs into the shared MCP library.
 *
 * The protocol and the budgets are pinned by `mcp.test.ts` next to this file
 * and by the runtime's end-to-end suite, which runs this library through the
 * runtime's thin wrappers. What is new is only the injection: the config file
 * port, the process launcher, and the error type. Each is exercised here with
 * no runtime, no Cordis and no child process at all — the shape a DSH host row
 * (P1-16b) will drive it in.
 */

/** Stands in for a host's own error type, e.g. the runtime's `RuntimeHostError`. */
class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

/** A host file port over an in-memory map; a missing file rejects the way `fs` does. */
function memoryFiles(files: Record<string, string>): McpConfigFiles & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(path, options) {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw enoent();
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > options.maxBytes)
        throw Object.assign(new Error('file too large'), { code: 'io_too_large' });
      return { bytes };
    },
  };
}

const declare = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

/** A spawn request whose output nobody reads, for driving a client by hand. */
const bareRequest = () => ({
  command: 'x',
  args: [],
  cwd: '/',
  env: {},
  onStdout: () => undefined,
  onStderr: () => undefined,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the config file port', () => {
  it('reads a missing file as absent and reports any other failure', async () => {
    const io = memoryFiles({
      [join('/agent', 'mcp.json')]: `{"mcpServers":{},"pad":"${'x'.repeat(300 * 1024)}"}`,
    });
    await expect(mcpConfigSource(io).readText('/nowhere/mcp.json')).resolves.toBeUndefined();
    const loaded = await loadMcpConfig(mcpConfigSource(io), { agentDir: '/agent' });
    expect(loaded.servers).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      { code: 'read_failed', path: join('/agent', 'mcp.json'), message: 'file too large' },
    ]);
  });
});

describe('the process launcher', () => {
  it('starts each declared server through the host, in the session workspace', async () => {
    const io = memoryFiles({
      [join('/agent', 'mcp.json')]: declare({
        echo: { command: 'node', args: ['server.mjs'], env: { TOKEN: 't' } },
      }),
    });
    const launcher = scriptedLauncher({ tools: [{ name: 'echo', description: 'Echo' }] });
    const catalog = await connectMcpServers(io, launcher, { agentDir: '/agent', cwd: '/work' });
    expect(launcher.requests).toHaveLength(1);
    expect(launcher.requests[0]).toMatchObject({
      command: 'node',
      args: ['server.mjs'],
      cwd: '/work',
      env: { TOKEN: 't' },
    });
    const [connection] = catalog.connections;
    expect(connection.error).toBeUndefined();
    expect(connection.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(launcher.children[0].received.map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);

    const result = await connection.client?.callTool('echo', { text: 'hi' });
    expect(result?.content).toEqual([{ type: 'text', text: '{"text":"hi"}' }]);

    await connection.client?.close();
    expect(launcher.children[0].killed).toBe(true);
  });

  it('drains stderr into the log sink rather than dropping it', async () => {
    const io = memoryFiles({ [join('/agent', 'mcp.json')]: declare({ s: { command: 'x' } }) });
    const logged: string[] = [];
    const launcher = scriptedLauncher();
    await connectMcpServers(io, launcher, {
      agentDir: '/agent',
      log: (...args) => logged.push(args.join(' ')),
    });
    launcher.requests[0].onStderr(Buffer.from('booted\n'));
    expect(logged).toEqual(['[mcp:s] booted']);
  });

  it('records a server whose launch fails and still starts the others', async () => {
    const io = memoryFiles({
      [join('/agent', 'mcp.json')]: declare({ broken: { command: 'nope' }, ok: { command: 'x' } }),
    });
    const inner = scriptedLauncher({ tools: [{ name: 't' }] });
    const launcher = {
      async spawn(request: Parameters<typeof inner.spawn>[0]) {
        if (request.command === 'nope')
          throw Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
        return inner.spawn(request);
      },
    };
    const catalog = await connectMcpServers(io, launcher, { agentDir: '/agent' });
    expect(catalog.connections.map((item) => [item.server.name, item.error, item.client])).toEqual([
      ['broken', 'spawn nope ENOENT', undefined],
      ['ok', undefined, expect.any(McpClient)],
    ]);
    await catalog.connections[1].client?.close();
  });
});

describe('the error type', () => {
  it('defaults to McpError with the 1.0.x codes', async () => {
    const launcher = scriptedLauncher({ silent: true });
    const child = await launcher.spawn(bareRequest());
    const client = new McpClient({ child, timeoutMs: 20 });
    const failure = await client.callTool('t', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: 'mcp_timeout',
      message: 'tools/call did not answer in 20ms',
    });
    await client.close();
  });

  it("builds every rejection with the host's own type when one is injected", async () => {
    const createError = (code: string, message: string) => new HostError(code, message);
    const io = memoryFiles({ [join('/agent', 'mcp.json')]: declare({ s: { command: 'x' } }) });

    // A server that answers the call with a JSON-RPC error.
    const failing = scriptedLauncher({ callError: { code: -32000, message: 'no such file' } });
    const catalog = await connectMcpServers(io, failing, { agentDir: '/agent', createError });
    const rejected = await catalog.connections[0].client
      ?.callTool('t', {})
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(HostError);
    expect(rejected).toMatchObject({ code: 'mcp_error', message: 'no such file (code -32000)' });

    // A server that exits: every later call is a disconnect.
    failing.children[0].exit();
    await tick();
    const gone = await catalog.connections[0].client
      ?.callTool('t', {})
      .catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(HostError);
    expect(gone).toMatchObject({ code: 'mcp_disconnected' });
    expect(catalog.connections[0].error).toBe('the MCP server exited');

    // A cancel whose reason is not an error of its own.
    const quiet = scriptedLauncher({ silent: true });
    const child = await quiet.spawn(bareRequest());
    const client = new McpClient({ child, timeoutMs: 120_000, createError });
    const controller = new AbortController();
    const pending = client.callTool('t', {}, controller.signal).catch((error: unknown) => error);
    controller.abort('stopped');
    expect(await pending).toMatchObject({
      code: 'mcp_aborted',
      message: 'tools/call was cancelled',
    });
    await client.close();
  });

  it('names a server that outlived the whole connect budget, and stops it', async () => {
    const io = memoryFiles({ [join('/agent', 'mcp.json')]: declare({ slow: { command: 'x' } }) });
    const launcher = scriptedLauncher({ silent: true });
    const catalog = await connectMcpServers(io, launcher, {
      agentDir: '/agent',
      connectTimeoutMs: 60_000,
      connectAllTimeoutMs: 30,
    });
    expect(catalog.connections[0]).toMatchObject({
      error: 'slow was still starting when the 30ms MCP connect budget ran out',
      tools: [],
    });
    expect(catalog.connections[0].client).toBeUndefined();
    expect(launcher.children[0].killed).toBe(true);
  });
});

describe('what a host asks the permission gate and hands the model', () => {
  it('keeps the server and tool names a policy is written against', () => {
    // The model's name is clamped; the policy value is not recovered from it.
    expect(mcpToolName('slack.bot', 'post.message')).toBe('mcp__slack_bot__post_message');
    expect(mcpPolicyValue('slack.bot', 'post.message')).toBe('slack.bot:post.message');
  });

  it('previews the arguments as pretty JSON, capped', () => {
    expect(mcpArgumentsPreview({ a: 1 })).toEqual({ label: 'Arguments', text: '{\n  "a": 1\n}' });
    expect(mcpArgumentsPreview({ a: 'x'.repeat(5000) }).text).toHaveLength(4000);
  });

  it('labels a server-reported error in the text and leaves the rest of the result alone', () => {
    const folded = foldMcpToolResult({
      isError: true,
      content: [
        { type: 'text', text: 'missing' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    });
    expect(folded).toEqual({
      content: [
        { type: 'text', text: '[tool reported an error]\nmissing' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
      images: 1,
      isError: true,
    });
    expect(foldMcpToolResult({ content: [] })).toEqual({
      content: [{ type: 'text', text: '(no output)' }],
      images: 0,
      isError: false,
    });
    const long = foldMcpToolResult({
      content: [{ type: 'text', text: 'y'.repeat(MCP_OUTPUT_BYTES + 1) }],
    });
    expect(long.content[0]).toMatchObject({ type: 'text' });
    expect((long.content[0] as { text: string }).text.endsWith('\n[output truncated]')).toBe(true);
  });
});
