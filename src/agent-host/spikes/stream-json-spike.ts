/**
 * Phase 0 spike: spawn Cometix with --output-format stream-json
 *
 * Usage (Node 24):
 *   node --experimental-strip-types spikes/stream-json-spike.ts [--query "say hi"] [--probe-only]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { COMETIX_PIN } from '../pin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

interface SpikeResult {
  route: 'stream-json';
  ok: boolean;
  cometixVersion: string;
  cliPath?: string;
  structuredEvents: number;
  sawAssistantText: boolean;
  sawTool: boolean;
  exitCode: number | null;
  error?: string;
  notes: string[];
  sampleTypes: string[];
}

function parseArgs(argv: string[]): { query?: string; probeOnly: boolean } {
  const out: { query?: string; probeOnly: boolean } = { probeOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--query' && argv[i + 1]) {
      out.query = argv[i + 1];
      i += 1;
    }
    if (argv[i] === '--probe-only') out.probeOnly = true;
  }
  return out;
}

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
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
      // next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const notes: string[] = [];
  const result: SpikeResult = {
    route: 'stream-json',
    ok: false,
    cometixVersion: COMETIX_PIN.version,
    structuredEvents: 0,
    sawAssistantText: false,
    sawTool: false,
    exitCode: null,
    notes,
    sampleTypes: [],
  };

  notes.push(`node=${process.version}`);
  notes.push(`execPath=${process.execPath}`);

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

  if (args.probeOnly) {
    // Just verify --help / --version produces output under Node 24.
    const child = spawn(process.execPath, [cliPath, '--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (c) => resolve(c));
    });
    result.exitCode = code;
    notes.push(`versionOut=${out.trim().slice(0, 200)}`);
    result.ok = code === 0 || out.trim().length > 0;
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  const prompt = args.query ?? 'Reply with exactly: PONG';
  const cwd = process.env.AICLIENT_SPIKE_WORKDIR ?? path.resolve(hostRoot, '..', '..');

  // Common Claude Code print/stream flags — exact set may vary by release.
  const cliArgs = [
    cliPath,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  notes.push(`spawn: node ${cliArgs.join(' ')}`);

  const child = spawn(process.execPath, cliArgs, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as { type?: string; message?: unknown };
      result.structuredEvents += 1;
      const type = String(event.type ?? 'unknown');
      if (result.sampleTypes.length < 12) result.sampleTypes.push(type);
      if (type.includes('assistant') || type === 'assistant' || type === 'text') {
        result.sawAssistantText = true;
      }
      if (type.includes('tool')) result.sawTool = true;
    } catch {
      notes.push(`non-json-line: ${trimmed.slice(0, 80)}`);
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  result.exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', (c) => resolve(c));
  });

  if (stderr.trim()) {
    notes.push(`stderr=${stderr.trim().slice(0, 400)}`);
  }

  result.ok = result.structuredEvents > 0;
  if (!result.ok) {
    result.error =
      result.exitCode === 0
        ? 'process exited 0 but no JSONL events parsed'
        : `process exited ${String(result.exitCode)} with no structured events`;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

main();
