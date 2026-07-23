/**
 * Phase 0 spike: Claude Agent SDK via Cometix cli.js
 *
 * Usage (Node 24):
 *   node --experimental-strip-types spikes/agent-sdk-spike.ts [--query "say hi"]
 *
 * Env:
 *   ANTHROPIC_API_KEY / CLAUDE credentials as required by the SDK
 *   AICLIENT_SPIKE_WORKDIR — cwd for the query (default: repo root)
 */

import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMETIX_PIN, CLAUDE_AGENT_SDK_PIN_VERSION } from '../pin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

interface SpikeResult {
  route: 'agent-sdk';
  ok: boolean;
  cometixVersion: string;
  sdkVersion: string;
  cliPath?: string;
  structuredEvents: number;
  sawAssistantText: boolean;
  sawTool: boolean;
  error?: string;
  notes: string[];
}

function parseArgs(argv: string[]): { query?: string } {
  const out: { query?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--query' && argv[i + 1]) {
      out.query = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
  // Cometix restores npm layout; cli entry is typically cli.js at package root.
  const candidates = [
    path.join(root, 'cli.js'),
    path.join(root, 'cli.mjs'),
    path.join(root, 'bin', 'cli.js'),
    path.join(root, 'dist', 'cli.js'),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const notes: string[] = [];
  const result: SpikeResult = {
    route: 'agent-sdk',
    ok: false,
    cometixVersion: COMETIX_PIN.version,
    sdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
    structuredEvents: 0,
    sawAssistantText: false,
    sawTool: false,
    notes,
  };

  notes.push(`node=${process.version}`);
  notes.push(`execPath=${process.execPath}`);
  notes.push(`hostRoot=${hostRoot}`);

  let cliPath: string;
  try {
    cliPath = await resolveCometixCli();
    result.cliPath = cliPath;
    notes.push(`cliPath=${cliPath}`);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  let queryFn: ((opts: Record<string, unknown>) => AsyncIterable<unknown>) | undefined;
  try {
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
      query?: (opts: Record<string, unknown>) => AsyncIterable<unknown>;
      default?: { query?: (opts: Record<string, unknown>) => AsyncIterable<unknown> };
    };
    queryFn = sdk.query ?? sdk.default?.query;
    if (!queryFn) {
      throw new Error('claude-agent-sdk has no query() export');
    }
    notes.push('sdk.query export found');
  } catch (err) {
    result.error = `SDK import failed: ${err instanceof Error ? err.message : String(err)}`;
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  const prompt = args.query ?? 'Reply with exactly: PONG';
  const cwd = process.env.AICLIENT_SPIKE_WORKDIR ?? path.resolve(hostRoot, '..', '..');
  const timeoutMs = Number(process.env.AICLIENT_SPIKE_TIMEOUT_MS ?? 45000);

  // Many SDK versions accept pathToClaudeCodeExecutable / executable pointing at cli.js.
  const queryOptions: Record<string, unknown> = {
    prompt,
    cwd,
    pathToClaudeCodeExecutable: cliPath,
    executable: process.execPath,
    // Prefer bypassing interactive permission UI when supported.
    permissionMode: 'bypassPermissions',
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    notes.push(`starting query (timeout=${timeoutMs}ms)…`);
    const stream = queryFn({ ...queryOptions, abortController: abort, signal: abort.signal });
    for await (const event of stream) {
      if (abort.signal.aborted) break;
      result.structuredEvents += 1;
      const e = event as {
        type?: string;
        message?: { content?: unknown };
        name?: string;
      };
      const type = String(e.type ?? '');
      if (type.includes('assistant') || type === 'text' || type === 'message') {
        result.sawAssistantText = true;
      }
      if (type.includes('tool') || e.name) {
        result.sawTool = true;
      }
      // Cap log noise — keep first few event type names.
      if (result.structuredEvents <= 8) {
        notes.push(`event[${result.structuredEvents}]=${type || typeof event}`);
      }
    }
    result.ok = result.structuredEvents > 0;
    if (!result.ok) {
      result.error = abort.signal.aborted
        ? `timed out after ${timeoutMs}ms with zero structured events`
        : 'query completed with zero structured events';
    } else if (abort.signal.aborted) {
      notes.push('aborted after receiving some events (timeout)');
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    notes.push('query threw — see error field');
  } finally {
    clearTimeout(timer);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

main();
