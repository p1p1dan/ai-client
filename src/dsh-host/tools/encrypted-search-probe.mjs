/**
 * Encrypted-machine content search probe.
 *
 * Question: on the TSD-encrypted Windows host, which way of searching a file
 * sees plaintext? Node reads plaintext for most types; this checks whether
 * the bundled rg.exe does too. This probe runs the same literal
 * search over one known-encrypted file through every carrier we could ship:
 * node itself, rg.exe started by node (mmap on/off, file vs directory walk),
 * rg.exe started by cmd.exe, rg.exe fed plaintext on stdin by node, and the
 * system findstr / Select-String / git grep.
 *
 * Plain JavaScript with no dependencies; run it with the installed app's
 * bundled node:
 *
 *   & "$env:LOCALAPPDATA\Programs\PiLab Ai\resources\node-runtime\node.exe" `
 *     encrypted-search-probe.mjs <file> <needle> [--rg <rg.exe>]
 *
 * The report prints only booleans, sizes and exit codes, never the file path
 * or its content, so it can be pasted back as is.
 *
 * Field result (2026-10-28): rg.exe sees plaintext like node does, whatever
 * its parent; see docs/plantree/plans/dsh-rebase/evidence/encrypted-search-2026-10-28.md.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TSD_MAGIC = '%TSD-Header-###%';
const TIMEOUT_MS = 30_000;
const isWin = process.platform === 'win32';

function parseArgs(argv) {
  const positional = [];
  let rg;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--rg') rg = argv[++i];
    else positional.push(argv[i]);
  }
  const [file, needle = process.env.PROBE_NEEDLE] = positional;
  if (!file || !needle) {
    console.error('usage: node encrypted-search-probe.mjs <file> <needle> [--rg <rg.exe>]');
    process.exit(2);
  }
  return { file: resolve(file), needle, rg };
}

/** The app's rg.exe next to its bundled node, else this checkout's (Linux dry run). */
function findRg(override) {
  if (override) return override;
  const exe = isWin ? 'rg.exe' : 'rg';
  const candidates = [
    join(
      dirname(process.execPath),
      '..',
      'app.asar.unpacked',
      'node_modules',
      '@vscode',
      'ripgrep',
      'bin',
      exe
    ),
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'node_modules',
      '@vscode',
      'ripgrep',
      'bin',
      exe
    ),
  ];
  return candidates.find((p) => existsSync(p));
}

function bufferVerdict(buf, needle) {
  return {
    bytes: buf.length,
    tsdHeader: buf.subarray(0, TSD_MAGIC.length).toString('latin1') === TSD_MAGIC,
    found: buf.includes(Buffer.from(needle, 'utf8')),
  };
}

/** rg / findstr / git: exit 0 = match, 1 = no match, anything else = error. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (r.error) return { found: null, error: r.error.code || r.error.message };
  const out = r.stdout ? r.stdout.toString('utf8') : '';
  return {
    found: r.status === 0 ? true : r.status === 1 ? false : null,
    exit: r.status,
    stdoutBytes: out.length,
    stderr: r.stderr ? r.stderr.toString('utf8').trim().slice(0, 200) : '',
  };
}

async function readStream(file) {
  const chunks = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const { file, needle, rg } = parseArgs(process.argv.slice(2));
  if (!existsSync(file) || !statSync(file).isFile()) {
    console.error('not a file');
    process.exit(2);
  }
  const rgPath = findRg(rg);
  const dir = dirname(file);
  const name = basename(file);
  const results = [];
  const record = (id, what, result) => results.push({ id, what, ...result });

  // 1. Node in-process: the reference.
  const plain = readFileSync(file);
  record('node-readFileSync', 'bundled node reads the file', bufferVerdict(plain, needle));
  record(
    'node-readStream',
    'bundled node streams the file',
    bufferVerdict(await readStream(file), needle)
  );

  // 2. rg.exe with node as parent (how the app and the DSH grep tool run it).
  if (rgPath) {
    const base = ['--no-config', '-F', '-c'];
    record(
      'rg-file-no-mmap',
      'rg <- node, single file, --no-mmap',
      run(rgPath, [...base, '--no-mmap', '--', needle, file])
    );
    record(
      'rg-file-mmap',
      'rg <- node, single file, --mmap',
      run(rgPath, [...base, '--mmap', '--', needle, file])
    );
    record(
      'rg-dir-walk',
      'rg <- node, walks the directory (global search shape)',
      run(rgPath, [...base, '--no-ignore', '--hidden', '--glob', name, '--', needle, dir])
    );
    record(
      'rg-sees-tsd',
      'rg <- node finds the TSD magic (ciphertext view)',
      run(rgPath, [...base, '--no-mmap', '--', TSD_MAGIC, file])
    );
    record(
      'rg-stdin',
      'node reads plaintext, pipes it to rg stdin',
      run(rgPath, [...base, '--', needle], { input: plain })
    );
    if (isWin) {
      record(
        'rg-via-cmd',
        'rg <- cmd.exe <- node',
        run(
          'cmd.exe',
          ['/d', '/s', '/c', `""${rgPath}" --no-config -F -c --no-mmap -- "${needle}" "${file}""`],
          { windowsVerbatimArguments: true }
        )
      );
    }
  } else {
    record('rg', 'rg.exe not found; pass --rg <path>', { found: null, error: 'missing' });
  }

  // 3. System searchers.
  if (isWin) {
    record(
      'findstr',
      'findstr.exe /M /C:<needle>',
      run('findstr.exe', ['/M', `/C:${needle}`, file])
    );
    const ps = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'if (Select-String -LiteralPath $env:PROBE_FILE -SimpleMatch -Pattern $env:PROBE_NEEDLE -Quiet) { exit 0 } else { exit 1 }',
      ],
      { env: { ...process.env, PROBE_FILE: file, PROBE_NEEDLE: needle } }
    );
    record('ps-select-string', 'PowerShell 5.1 Select-String', ps);
  }
  const git = run('git', ['grep', '--no-index', '-F', '-c', '--', needle, name], { cwd: dir });
  record(
    'git-grep',
    'git grep --no-index',
    git.error === 'ENOENT' ? { found: null, error: 'git not on PATH' } : git
  );

  const summary = {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    execPath: basename(process.execPath),
    rg: rgPath ? basename(rgPath) : null,
    ext: extname(file) || '(none)',
    sizeOnDisk: statSync(file).size,
    needleLength: needle.length,
  };
  console.log(JSON.stringify(summary));
  for (const r of results) {
    const verdict = r.found === true ? 'FOUND   ' : r.found === false ? 'no match' : 'ERROR   ';
    const extra = [
      r.bytes !== undefined && `bytes=${r.bytes}`,
      r.tsdHeader !== undefined && `tsdHeader=${r.tsdHeader}`,
      r.exit !== undefined && `exit=${r.exit}`,
      r.error && `error=${r.error}`,
      r.stderr && `stderr=${JSON.stringify(r.stderr)}`,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`${verdict}  ${r.id.padEnd(18)} ${r.what}${extra ? `  [${extra}]` : ''}`);
  }
}

await main();
