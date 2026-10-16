// Small helpers the encrypted-machine kit's PowerShell runner calls with the
// app's bundled node (so the reads below are the product's own view).
//
//   node kit-tools.mjs tree <dir> [skipPrefix]   recursive: which files this node reads as TSD
//                                                ciphertext, by extension; `loadable` lists the
//                                                code / package files node would fail to load
//   node kit-tools.mjs heads <dir> <marker>      first bytes of every file in <dir>, classified
//   node kit-tools.mjs capture <dir>             the newest fake-gateway capture: message count
//                                                and whether the first user turn is the probe's
//   node kit-tools.mjs digest <enc-output.txt>   one line per sample: what the CLI saw and the
//                                                last on-disk check, plus per-cell counts
//   node kit-tools.mjs cat <file>                print a text file as this node reads it (on the
//                                                encrypted machine node decrypts most text types,
//                                                where claude.exe sees TSD ciphertext)
//   <electron> kit-tools.mjs spawn <exe> [...]   run <exe> as a child, stdio inherited, without
//                                                ELECTRON_RUN_AS_NODE (puts the app's own exe in
//                                                the process chain above node and claude.exe)
//
// heads / capture print one JSON line and never print file contents.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

const HEAD_BYTES = 256;
const TSD_MAGIC = '%TSD-Header';

function head(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('latin1');
  } finally {
    closeSync(fd);
  }
}

function heads(dir, marker) {
  const files = {};
  const counts = { TSD: 0, plain: 0, other: 0, error: 0 };
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    let kind;
    try {
      const text = head(file);
      kind = text.includes(TSD_MAGIC) ? 'TSD' : marker && text.includes(marker) ? 'plain' : 'other';
    } catch {
      kind = 'error';
    }
    files[name] = kind;
    counts[kind] += 1;
  }
  return { ok: true, dir, counts, files };
}

// What node loads as code or package metadata: one of these read as ciphertext means a
// SyntaxError (or a broken package) the moment it is imported.
const LOADABLE = new Set(['.js', '.mjs', '.cjs', '.ts', '.json']);

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
}

function tree(root, skipPrefix) {
  const byExt = {};
  const loadable = [];
  let total = 0;
  let tsd = 0;
  let errors = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipPrefix && entry.name.startsWith(skipPrefix)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      total += 1;
      const ext = extensionOf(entry.name);
      byExt[ext] ??= { files: 0, tsd: 0 };
      const slot = byExt[ext];
      slot.files += 1;
      let text;
      try {
        text = head(file);
      } catch {
        errors += 1;
        continue;
      }
      if (!text.startsWith(TSD_MAGIC)) continue;
      tsd += 1;
      slot.tsd += 1;
      if (LOADABLE.has(ext)) loadable.push(file.slice(root.length).replace(/^[\\/]/, ''));
    }
  };
  walk(root);
  const encryptedTypes = Object.fromEntries(
    Object.entries(byExt)
      .filter(([, slot]) => slot.tsd > 0)
      .map(([ext, slot]) => [ext, `${slot.tsd}/${slot.files}`])
  );
  return {
    ok: true,
    total,
    tsd,
    errors,
    encryptedTypes,
    loadableTsd: loadable.length,
    loadable: loadable.slice(0, 200),
  };
}

function capture(dir) {
  if (!existsSync(dir)) return { ok: false, error: 'no capture directory' };
  const numbered = readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  if (numbered.length === 0) return { ok: false, error: 'no captures' };
  const last = numbered.at(-1);
  const body = JSON.parse(JSON.parse(readFileSync(join(dir, last), 'utf8')).body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.find((m) => m.role === 'user');
  const text = Array.isArray(firstUser?.content)
    ? firstUser.content.map((part) => part?.text ?? '').join('')
    : String(firstUser?.content ?? '');
  return {
    ok: true,
    captures: numbered.length,
    newest: last,
    messages: messages.length,
    firstUserIsProbeText: text.includes('CC-TEXT'),
  };
}

/**
 * Condense one `host-probe.ts enc` output: the ENC-MATRIX rows joined with the last
 * on-disk section (the delayed recheck when there is one), per-cell counts first.
 */
function digest(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = new Map();
  const at = lines.findIndex((line) => line.startsWith('=== ENC-MATRIX'));
  if (at < 0) return ['  （没有 ENC-MATRIX，看完整输出）'];
  for (const line of lines.slice(at + 1)) {
    const match = /^ {2}(\S.*?): (.+)$/.exec(line);
    if (!match) break;
    rows.set(match[1], match[2].trim());
  }
  const lastDisk = lines.findLastIndex((line) => line.startsWith('=== on disk'));
  const disk = new Map();
  let transcript = '（没有）';
  if (lastDisk >= 0) {
    for (const line of lines.slice(lastDisk + 1)) {
      const match = /^ {2}(\S.*?)\s+node=(\S+)(?:\s+ps51=(\S+))?\s*$/.exec(line);
      if (!match) break;
      const views = `node=${match[2]} ps51=${match[3] ?? '-'}`;
      if (match[1] === 'transcript') {
        transcript = views;
        continue;
      }
      const kind = /\((edited|written)\)$/.exec(match[1]);
      if (!kind) continue;
      const name = match[1].slice(0, -kind[0].length).trim();
      disk.set(`${name}|${kind[1]}`, views);
    }
  }
  const counts = new Map();
  for (const cells of rows.values()) {
    for (const cell of cells.split(/\s+/)) {
      const [name, value] = cell.split('=');
      if (!value) continue;
      const tally = counts.get(name) ?? new Map();
      tally.set(value, (tally.get(value) ?? 0) + 1);
      counts.set(name, tally);
    }
  }
  const out = [];
  out.push(
    `  统计（${rows.size} 个样本）：${[...counts]
      .map(([name, tally]) => `${name} ${[...tally].map(([v, n]) => `${v}=${n}`).join(',')}`)
      .join(' | ')}`
  );
  out.push(
    `  落盘：${lastDisk >= 0 ? lines[lastDisk].replace(/^=== on disk /, '').split(':')[0] : '（没有）'}；transcript ${transcript}`
  );
  for (const [name, cells] of rows) {
    out.push(
      `  ${name} | ${cells} | edited ${disk.get(`${name}|edited`) ?? '-'} | written ${disk.get(`${name}|written`) ?? '-'}`
    );
  }
  const written = lines.find((line) => line.trim().startsWith('written files:'));
  if (written) out.push(`  ${written.trim()}`);
  return out;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'spawn') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // The link the runner's ancestry line cannot see: this exe sits between it and node.
  console.log(
    `出身链补充：${process.execPath} pid=${process.pid} ppid=${process.ppid} -> ${args[0]}`
  );
  const child = spawnSync(args[0], args.slice(1), { stdio: 'inherit', env });
  if (child.error) console.log(`  （spawn 失败：${child.error.message}）`);
  process.exit(child.status ?? 1);
} else if (command === 'digest' || command === 'cat') {
  try {
    if (command === 'digest') console.log(digest(args[0]).join('\n'));
    else process.stdout.write(readFileSync(args[0], 'utf8'));
  } catch (error) {
    console.log(`  （${command} 失败：${String(error?.message ?? error)}）`);
  }
} else {
  let reply;
  try {
    if (command === 'tree') reply = tree(args[0], args[1] ?? '');
    else if (command === 'heads') reply = heads(args[0], args[1] ?? '');
    else if (command === 'capture') reply = capture(args[0]);
    else
      reply = {
        ok: false,
        error:
          'usage: kit-tools tree <dir> [skipPrefix] | heads <dir> <marker> | capture <dir> | digest <file> | cat <file>',
      };
  } catch (error) {
    reply = { ok: false, error: String(error?.message ?? error) };
  }
  console.log(JSON.stringify(reply));
}
