/**
 * Traversal benchmark for `glob` and `grep` (tools-20).
 *
 * Why a script and not a test: the numbers it prints are wall clock on a real
 * filesystem, so they are evidence rather than an assertion — a threshold that
 * passes on one box fails on the next, and the suite would own a tree of
 * ~19 000 files. Run it by hand before and after a traversal change:
 *
 *   node --experimental-strip-types smoke/searchBench.ts
 *   node --experimental-strip-types smoke/searchBench.ts --files 5000 --keep
 *
 * The tree it builds imitates the shape that made the Windows field run slow: a
 * C++ workspace whose build output and vendored SDK hold most of the entries,
 * six levels deep, with a `.gitignore` that names the build directories.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';

interface Options {
  files: number;
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { files: 19_000, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') options.files = Number(argv[++i]);
    else if (argv[i] === '--keep') options.keep = true;
  }
  if (!Number.isInteger(options.files) || options.files < 1)
    throw new Error('--files needs a positive integer');
  return options;
}

/**
 * Lay out `budget` files across a six-level tree, most of them under the two
 * directories a `.gitignore` would exclude.
 */
async function buildTree(root: string, budget: number): Promise<{ files: number; dirs: number }> {
  let files = 0;
  let dirs = 0;
  const write = async (directory: string, count: number, extension: string) => {
    await mkdir(directory, { recursive: true });
    dirs++;
    const batch: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      // One needle per hundred files, so grep has hits without the match count
      // itself dominating the run.
      const body =
        i % 100 === 0
          ? `// StationTransfer marker ${i}\nint value_${i} = ${i};\n`
          : `int value_${i} = ${i};\n`;
      batch.push(writeFile(join(directory, `file_${i}${extension}`), body));
      if (batch.length === 256) {
        await Promise.all(batch.splice(0));
      }
    }
    await Promise.all(batch);
    files += count;
  };
  await writeFile(join(root, '.gitignore'), 'build/\nobj/\n*.log\n/out\n');
  // Hand-written sources: shallow, few, and the only files a developer edits.
  for (let module = 0; module < 8; module++) {
    const base = join(root, 'src', `module_${module}`);
    await write(join(base, 'core'), Math.round(budget * 0.002), '.cpp');
    await write(join(base, 'core', 'detail'), Math.round(budget * 0.002), '.h');
  }
  // Vendored SDK headers: deep, many, not ignored by git.
  for (let vendor = 0; vendor < 6; vendor++) {
    let base = join(root, 'ThirdParty', `sdk_${vendor}`);
    for (let depth = 0; depth < 4; depth++) {
      base = join(base, `level_${depth}`);
      await write(base, Math.round(budget * 0.015), '.h');
    }
  }
  // Build output: the bulk of the entries, and what `.gitignore` names.
  for (const output of ['build', 'obj']) {
    for (let config = 0; config < 4; config++) {
      let base = join(root, output, `config_${config}`);
      for (let depth = 0; depth < 3; depth++) {
        base = join(base, `step_${depth}`);
        await write(base, Math.round(budget * 0.025), '.obj');
      }
    }
  }
  return { files, dirs };
}

function faux() {
  const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  provider.setResponses([fauxAssistantMessage('ready')]);
  return provider;
}

async function callTool(
  runtime: RuntimeHandle,
  name: string,
  params: Record<string, unknown>
): Promise<{ ms: number; details: Record<string, unknown> }> {
  const tool = runtime.ctx.runtimeTools.list().find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const startedAt = performance.now();
  const output = await tool.execute(`bench-${name}`, params);
  const ms = performance.now() - startedAt;
  return { ms, details: (output.details ?? {}) as Record<string, unknown> };
}

/** Runs a case, or says why it could not run — the baseline build has no `respectGitignore`. */
async function tryTool(
  runtime: RuntimeHandle,
  label: string,
  name: string,
  params: Record<string, unknown>
): Promise<void> {
  try {
    report(label, await callTool(runtime, name, params));
  } catch (error) {
    process.stdout.write(`${label.padEnd(34)} skipped: ${(error as Error).message}\n`);
  }
}

function report(label: string, run: { ms: number; details: Record<string, unknown> }): void {
  const found = Array.isArray(run.details.files) ? run.details.files.length : undefined;
  process.stdout.write(
    `${label.padEnd(34)} ${run.ms.toFixed(0).padStart(7)} ms  visited=${String(
      run.details.visited ?? '?'
    ).padStart(6)}${found === undefined ? '' : `  files=${found}`}${
      run.details.truncated ? '  [truncated]' : ''
    }\n`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), 'runtime-search-bench-'));
  let runtime: RuntimeHandle | undefined;
  try {
    const built = await buildTree(root, options.files);
    process.stdout.write(`tree ${root}: ${built.files} files in ${built.dirs} directories\n`);
    runtime = await createRuntime({
      providers: [faux().provider],
      env: {},
      host: standaloneHost({ PATH: process.env.PATH }),
      tools: { cwd: root },
      permissions: { approve: async () => 'deny' },
    });
    // Two rounds: the first pays for the page cache, the second is the number
    // worth comparing between builds.
    // Patterns that match nothing, so the walk runs to the end instead of
    // stopping at the result limit: what is being measured is the traversal,
    // and a case that truncates measures how fast the first 100 hits arrive.
    for (const round of [1, 2]) {
      await tryTool(runtime, `glob full walk (round ${round})`, 'glob', {
        pattern: '**/*.no-such-extension',
      });
      await tryTool(runtime, `glob full walk, no ignore (${round})`, 'glob', {
        pattern: '**/*.no-such-extension',
        respectGitignore: false,
      });
      await tryTool(runtime, `grep full walk (round ${round})`, 'grep', {
        pattern: 'no-such-needle-anywhere',
      });
      await tryTool(runtime, `grep full walk, no ignore (${round})`, 'grep', {
        pattern: 'no-such-needle-anywhere',
        respectGitignore: false,
      });
      await tryTool(runtime, `glob **/*.h limit 1000 (${round})`, 'glob', {
        pattern: '**/*.h',
        limit: 1000,
      });
    }
  } finally {
    await runtime?.dispose();
    if (options.keep) process.stdout.write(`kept ${root}\n`);
    else await rm(root, { recursive: true, force: true });
  }
}

await main();
