import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptedLauncher } from '../../shared/mcp/__tests__/fixtures/scriptedServer.ts';
import * as sharedMcpClient from '../../shared/mcp/client.ts';
import * as sharedMcpConfig from '../../shared/mcp/config.ts';
import * as sharedMcpConnect from '../../shared/mcp/connect.ts';
import * as sharedMcpNaming from '../../shared/mcp/naming.ts';
import * as sharedMcpResults from '../../shared/mcp/results.ts';
import * as sharedSettingSources from '../../shared/settingSources.ts';
import * as sharedCatalog from '../../shared/skills/catalog.ts';
import * as sharedExpand from '../../shared/skills/expand.ts';
import * as sharedLoader from '../../shared/skills/loader.ts';
import * as sharedTemplates from '../../shared/skills/templates.ts';
import type { RuntimeExecService, RuntimeHostIoService } from '../contracts.ts';
import { RuntimeHostError } from '../host/errors.ts';
import * as mcpClient from '../plugins/mcp/client.ts';
import * as mcpConfig from '../plugins/mcp/config.ts';
import * as mcpIndex from '../plugins/mcp/index.ts';
import * as skillsExpand from '../plugins/skills/expand.ts';
import * as skillsIndex from '../plugins/skills/index.ts';
import * as skillsLoader from '../plugins/skills/loader.ts';
import * as skillsTemplates from '../plugins/skills/templates.ts';
import * as settingSources from '../settingSources.ts';

/**
 * dsh-rebase P1-16 prep — the runtime half of the move.
 *
 * The skills, template, expansion and MCP logic now lives in `src/shared`, and
 * the runtime's old modules re-export it or wrap it. Two promises the wrappers
 * make and the moved suites cannot check from the shared side: every name the
 * runtime exported before the move is still exported from the same module
 * (and a re-export IS the shared value, not a copy that could drift), and
 * every MCP rejection still reaches the runtime as a `RuntimeHostError` with
 * the 1.0.x code, which is what its callers test for.
 */

type Module = Record<string, unknown>;

/** [runtime module, its value exports before the move, the shared module each re-export must equal]. */
const reexports: [string, Module, Record<string, Module>][] = [
  [
    'plugins/skills/loader.ts',
    skillsLoader,
    {
      loadSkills: sharedLoader,
      MAX_DESCRIPTION_BYTES: sharedLoader,
      MAX_SKILL_DEPTH: sharedLoader,
      MAX_SKILLS: sharedLoader,
      parseFrontmatter: sharedLoader,
      resolveEntryKind: sharedLoader,
    },
  ],
  [
    'plugins/skills/templates.ts',
    skillsTemplates,
    {
      loadPromptTemplates: sharedTemplates,
      MAX_TEMPLATE_BYTES: sharedTemplates,
      MAX_TEMPLATES: sharedTemplates,
      templateBody: sharedTemplates,
    },
  ],
  [
    'plugins/skills/expand.ts',
    skillsExpand,
    {
      expandPrompt: sharedExpand,
      formatSkillInvocation: sharedExpand,
      parseCommandArgs: sharedExpand,
      parseSlashInvocation: sharedExpand,
      substituteArgs: sharedExpand,
    },
  ],
  [
    'plugins/skills/index.ts',
    skillsIndex,
    {
      loadSkillCatalog: sharedCatalog,
      MAX_SCAN_BYTES: sharedCatalog,
      MAX_SKILL_BYTES: sharedCatalog,
      parseSlashInvocation: sharedExpand,
      skillRoots: sharedCatalog,
      skillSource: sharedCatalog,
      templateRoots: sharedCatalog,
    },
  ],
  [
    'plugins/mcp/config.ts',
    mcpConfig,
    {
      hostServerBudget: sharedMcpConfig,
      loadMcpConfig: sharedMcpConfig,
      MAX_CONFIG_BYTES: sharedMcpConfig,
      MAX_SERVERS: sharedMcpConfig,
      mcpConfigFiles: sharedMcpConfig,
      mcpConfigSource: sharedMcpConfig,
      sessionServerBudget: sharedMcpConfig,
      workerSlotBudget: sharedMcpConfig,
    },
  ],
  [
    'plugins/mcp/client.ts',
    mcpClient,
    { MAX_MESSAGE_BYTES: sharedMcpClient, MCP_PROTOCOL_VERSION: sharedMcpClient },
  ],
  [
    'plugins/mcp/index.ts',
    mcpIndex,
    {
      MCP_CALL_TIMEOUT_MS: sharedMcpConnect,
      MCP_CONNECT_ALL_TIMEOUT_MS: sharedMcpConnect,
      MCP_CONNECT_TIMEOUT_MS: sharedMcpConnect,
      MCP_IMAGE_BYTES: sharedMcpResults,
      MCP_IMAGE_TOTAL_BYTES: sharedMcpResults,
      MCP_MAX_IMAGES: sharedMcpResults,
      MCP_OUTPUT_BYTES: sharedMcpResults,
      mcpToolName: sharedMcpNaming,
    },
  ],
  [
    'settingSources.ts',
    settingSources,
    {
      ALL_SETTING_SOURCES: sharedSettingSources,
      resolveSettingSources: sharedSettingSources,
    },
  ],
];

/** Value exports each module keeps as its own (not a re-export), with any the move added. */
const ownExports: Record<string, string[]> = {
  'plugins/skills/index.ts': ['SKILLS_SERVICE', 'SkillsPlugin'],
  'plugins/mcp/client.ts': ['McpClient', 'runtimeMcpError'],
  'plugins/mcp/index.ts': ['MCP_SERVICE', 'McpPlugin', 'connectMcpServers'],
};

describe('the runtime modules still export what they did', () => {
  it.each(reexports)('%s: the same value names', (file, runtime, shared) => {
    expect(Object.keys(runtime).sort()).toEqual(
      [...Object.keys(shared), ...(ownExports[file] ?? [])].sort()
    );
  });

  it.each(reexports)('%s: each re-export is the shared value itself', (_file, runtime, shared) => {
    for (const [name, source] of Object.entries(shared))
      expect(runtime[name], name).toBe(source[name]);
  });

  it('keeps the service names and plugin classes that are the runtime’s own', () => {
    expect(skillsIndex.SKILLS_SERVICE).toBe('runtimeSkills');
    expect(mcpIndex.MCP_SERVICE).toBe('runtimeMcp');
    expect(typeof skillsIndex.SkillsPlugin).toBe('function');
    expect(typeof mcpIndex.McpPlugin).toBe('function');
    expect(new mcpClient.McpClient({ child: silentChild(), timeoutMs: 1000 })).toBeInstanceOf(
      sharedMcpClient.McpClient
    );
  });
});

function silentChild() {
  return {
    write: async () => undefined,
    exited: new Promise<{ exitCode: number | null; signal: string | null }>(() => undefined),
    kill: async () => undefined,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('MCP rejections are still RuntimeHostError', () => {
  it('from a client the runtime constructs', async () => {
    const timeout = new mcpClient.McpClient({ child: silentChild(), timeoutMs: 20 });
    const timedOut = await timeout.callTool('t', {}).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(RuntimeHostError);
    expect(timedOut).toMatchObject({
      code: 'mcp_timeout',
      message: 'tools/call did not answer in 20ms',
    });
    await timeout.close();
    const gone = await timeout.callTool('t', {}).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(RuntimeHostError);
    expect(gone).toMatchObject({ code: 'mcp_disconnected', message: 'the MCP server is gone' });

    // The server's JSON-RPC error, fed in the way the spawner wires stdout.
    const refused = new mcpClient.McpClient({ child: silentChild(), timeoutMs: 1000 });
    const pending = refused.callTool('t', {}).catch((error: unknown) => error);
    refused.receive(
      Buffer.from(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } })}\n`
      )
    );
    const failure = await pending;
    expect(failure).toBeInstanceOf(RuntimeHostError);
    expect(failure).toMatchObject({ code: 'mcp_error', message: 'nope (code -32000)' });

    const aborting = new mcpClient.McpClient({ child: silentChild(), timeoutMs: 120_000 });
    const controller = new AbortController();
    const cancelled = aborting
      .callTool('t', {}, controller.signal)
      .catch((error: unknown) => error);
    controller.abort('stopped');
    expect(await cancelled).toBeInstanceOf(RuntimeHostError);
    expect(await cancelled).toMatchObject({ code: 'mcp_aborted' });
    await aborting.close();
  });

  it("from a client the shared connect phase constructs through the runtime's exits", async () => {
    const config = JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['s.mjs'] } } });
    const io = {
      async readFile(path: string) {
        if (path === join('/agent', 'mcp.json')) return { bytes: Buffer.from(config) };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    } as unknown as RuntimeHostIoService;
    const launcher = scriptedLauncher({ tools: [{ name: 'echo' }] });
    const exec = { spawn: launcher.spawn } as unknown as RuntimeExecService;

    const catalog = await mcpIndex.connectMcpServers(io, exec, {
      agentDir: '/agent',
      cwd: '/work',
    });
    const [connection] = catalog.connections;
    expect(connection.error).toBeUndefined();
    expect(connection.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(launcher.requests[0]).toMatchObject({ command: 'node', args: ['s.mjs'], cwd: '/work' });

    launcher.children[0].exit();
    await tick();
    const gone = await connection.client?.callTool('echo', {}).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(RuntimeHostError);
    expect(gone).toMatchObject({ code: 'mcp_disconnected' });
    expect(connection.error).toBe('the MCP server exited');
  });
});
