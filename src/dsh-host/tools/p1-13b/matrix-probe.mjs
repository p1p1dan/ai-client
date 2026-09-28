/**
 * P1-13b encryption matrix probe (dsh-rebase plan).
 *
 * Plain JavaScript with no dependencies, so the same file runs under the
 * installed app's resources\node-runtime\node.exe, under the app's Electron
 * exe with ELECTRON_RUN_AS_NODE=1, and under a renamed copy of node.exe.
 * run-p1-13b.ps1 drives it; nothing here starts a host, a gateway or a model,
 * or opens a network connection.
 *
 *   <node> matrix-probe.mjs ping|plan|read|write      request JSON in env P113B_REQUEST,
 *                                                       one JSON reply line on stdout
 *   <node> matrix-probe.mjs report --out-dir <dir>     JSONL records on stdin ->
 *                                                       matrix.json + summary.txt
 *   <node> matrix-probe.mjs --rehearsal [--out <dir>] [--delay <s>] [--keep]
 *                                                       whole flow in a temp dir (Linux dry run)
 *
 * Replies escape every non-ASCII character, so the console code page on the
 * reading side never matters. Readers report raw head bytes as hex; the
 * classification happens once, in the report, from those bytes.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { release as osRelease, type as osType, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TSD_MAGIC = '%TSD-Header-###%';
export const MARKER_PREFIX = 'P113B-MARKER-';
export const HEAD_BYTES = 64;

/** Extensions probed as `p113b.<ext>`. */
export const EXTENSIONS = Object.freeze([
  'txt',
  'md',
  'json',
  'jsonl',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'py',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'kt',
  'rb',
  'php',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'xml',
  'html',
  'css',
  'scss',
  'vue',
  'csv',
  'log',
  'patch',
  'diff',
  'lock',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
]);

/** Whole file names: extensionless files, and two names the product really writes. */
export const SPECIAL_NAMES = Object.freeze([
  'Makefile',
  'Dockerfile',
  'README',
  '.env',
  'session.v4.jsonl.zstd',
]);

export const READERS = Object.freeze([
  {
    id: 'R-node',
    short: 'node',
    label: '随包 node.exe（AppDir\\resources\\node-runtime\\node.exe）',
  },
  {
    id: 'R-electron',
    short: 'electron',
    label: 'Electron 主程序，ELECTRON_RUN_AS_NODE=1（1.0.x 主进程读文件的载体）',
  },
  {
    id: 'R-renamed',
    short: 'renamed',
    label: 'node.exe 的改名副本 %TEMP%\\p113b-<时间>\\p113b-raw.exe',
  },
  { id: 'R-ps51', short: 'ps51', label: 'Windows PowerShell 5.1 [IO.File]::ReadAllBytes' },
  { id: 'R-pwsh7', short: 'pwsh7', label: 'PowerShell 7 [IO.File]::ReadAllBytes' },
  { id: 'R-certutil', short: 'certutil', label: 'certutil -dump（只输出到 stdout）' },
  { id: 'R-bash', short: 'bash', label: 'Git Bash：head -c 64 | od' },
]);

export const WRITERS = Object.freeze([
  {
    id: 'W-node-create',
    short: 'create',
    runner: 'node',
    mode: 'create',
    label: 'node.exe writeFileSync 直接新建（与 1.0.x 写文件工具同一写法）',
  },
  {
    id: 'W-node-dsh-create',
    short: 'dshlink',
    runner: 'node',
    mode: 'dsh-create',
    label: 'node.exe 仿 DSH write 新建：隐藏暂存目录里写 <名>.tmp，再硬链接成目标名',
  },
  {
    id: 'W-node-rename',
    short: 'rename',
    runner: 'node',
    mode: 'rename',
    label: 'node.exe 暂存目录里写 <名>.tmp，再 rename 成目标名',
  },
  {
    id: 'W-node-copy',
    short: 'copy',
    runner: 'node',
    mode: 'copy-only',
    label: 'node.exe copyFileSync 复制同类型的已加密输入，不改内容',
  },
  {
    id: 'W-node-copy-then-write',
    short: 'copy+w',
    runner: 'node',
    mode: 'copy-then-write',
    label: 'node.exe 先 copyFileSync 同类型的已加密输入，再 writeFileSync 覆盖内容',
  },
  {
    id: 'W-node-edit-existing',
    short: 'edit',
    runner: 'node',
    mode: 'edit-existing',
    label: 'node.exe 复制已加密输入后读出、替换一段文字、原路径写回（1.0.x 编辑工具的写法）',
  },
  {
    id: 'W-electron-create',
    short: 'e-create',
    runner: 'electron',
    mode: 'create',
    label: 'Electron（ELECTRON_RUN_AS_NODE=1）writeFileSync 新建',
  },
  {
    id: 'W-renamed-create',
    short: 'r-create',
    runner: 'renamed',
    mode: 'create',
    label: 'node.exe 改名副本 writeFileSync 新建',
  },
  {
    id: 'W-ps51',
    short: 'ps51',
    runner: 'ps51',
    mode: 'set-content',
    label: 'Windows PowerShell 5.1 Set-Content 新建',
  },
]);

const PHASES = Object.freeze(['immediate', 'delayed']);
/** Types the product writes most; asked first when manual checks must be rationed. */
const MANUAL_PRIORITY = Object.freeze([
  'txt',
  'md',
  'json',
  'yml',
  'ts',
  'py',
  'docx',
  '.env',
  'session.v4.jsonl.zstd',
]);
const EDIT_NEEDLE = 'plaintext line';

export const newMarker = () => `${MARKER_PREFIX}${randomBytes(4).toString('hex')}`;
export const inputContent = (marker, key) => `${marker} ${key} ${EDIT_NEEDLE}`;
export const writerContent = (marker, key, writer) => `${marker} ${key} written by ${writer}\r\n`;

/** One entry per probed file type: `key` names the matrix row, `name` the file. */
export function planItems(marker) {
  const items = EXTENSIONS.map((ext) => ({ key: ext, name: `p113b.${ext}` }));
  for (const name of SPECIAL_NAMES) items.push({ key: name, name });
  return items.map((item) => ({ ...item, content: inputContent(marker, item.key) }));
}

// ---- classification (pure) --------------------------------------------------

export function hexToBytes(hex) {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  const out = Buffer.alloc(Math.floor(clean.length / 2));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * 'ciphertext' when the TSD container header shows up, 'plaintext' when the
 * run's marker does, 'other' for anything else (including an empty file).
 */
export function classifyBytes(bytes, marker = MARKER_PREFIX) {
  const text = Buffer.from(bytes ?? []).toString('latin1');
  if (text.includes(TSD_MAGIC)) return 'ciphertext';
  if (marker && text.includes(marker)) return 'plaintext';
  return 'other';
}

export const classifyHex = (hex, marker) => classifyBytes(hexToBytes(hex), marker);

export function asciiPreview(hex, max = 32) {
  return Array.from(hexToBytes(hex).subarray(0, max), (byte) =>
    byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'
  ).join('');
}

/**
 * First HEAD_BYTES bytes of a `certutil -dump` hex listing, as hex; null when
 * the output holds no hex rows. Rows look like
 * `  0000  25 54 53 44 2d 48 65 61  64 65 72 2d 23 23 23 25   %TSD-Header-###%`:
 * an offset, up to 16 byte pairs (one extra space after the 8th), then three or
 * more spaces and the ASCII column. Rows must be contiguous from offset 0.
 */
export function parseCertutilDump(text, limit = HEAD_BYTES) {
  const bytes = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const row =
      /^\s*([0-9a-fA-F]{4,8})\s+([0-9a-fA-F]{2}(?:\s{1,2}[0-9a-fA-F]{2})*)(?:\s{3,}.*)?\s*$/.exec(
        line
      );
    if (!row) continue;
    const offset = Number.parseInt(row[1], 16);
    if (offset !== bytes.length) {
      if (bytes.length > 0) break;
      continue;
    }
    const pairs = row[2].trim().split(/\s+/).slice(0, 16);
    bytes.push(...pairs.map((pair) => Number.parseInt(pair, 16)));
    if (bytes.length >= limit) break;
  }
  if (bytes.length === 0) return null;
  return Buffer.from(bytes.slice(0, limit)).toString('hex');
}

export function resultHex(result) {
  if (!result) return null;
  if (typeof result.hex === 'string') return result.hex;
  if (typeof result.certutilDump === 'string') return parseCertutilDump(result.certutilDump);
  return null;
}

/** plaintext | ciphertext | other | missing | error | skipped. */
export function resultClass(result, marker) {
  if (!result) return 'skipped';
  if (result.error) return 'error';
  if (result.exists === false) return 'missing';
  const hex = resultHex(result);
  if (hex === null) return 'error';
  return classifyHex(hex, marker);
}

/**
 * How the type's effective observers saw one output file:
 * ENC all read the TSD header; PLAIN all read the marker; OTHER all read other
 * bytes; MIX they disagree; ERR none of them could read it; NOOBS the type has
 * no effective observer; FAIL the writer failed on this file.
 */
export function verdictOf(observerIds, classes, writeOk) {
  if (writeOk === false) return 'FAIL';
  if (!observerIds || observerIds.length === 0) return 'NOOBS';
  const seen = observerIds
    .map((id) => classes?.[id])
    .filter((value) => value === 'plaintext' || value === 'ciphertext' || value === 'other');
  if (seen.length === 0) return 'ERR';
  if (seen.every((value) => value === 'ciphertext')) return 'ENC';
  if (seen.every((value) => value === 'plaintext')) return 'PLAIN';
  if (seen.every((value) => value === 'other')) return 'OTHER';
  return 'MIX';
}

export const CLASS_CODE = Object.freeze({
  plaintext: 'P',
  ciphertext: 'C',
  other: 'O',
  missing: 'M',
  error: 'E',
  skipped: '-',
});
export const VERDICT_CODE = Object.freeze({
  ENC: 'C',
  PLAIN: 'P',
  MIX: 'X',
  OTHER: 'O',
  ERR: 'E',
  NOOBS: '?',
  FAIL: 'F',
  '-': '-',
});
const CLASS_NAME = {
  plaintext: '明文',
  ciphertext: 'TSD 头',
  other: '其他',
  missing: '不存在',
  error: '出错',
  skipped: '未测',
};
const VERDICT_NAME = {
  ENC: 'C（TSD 头）',
  PLAIN: 'P（明文）',
  MIX: 'X（不一致）',
  OTHER: 'O（其他）',
  ERR: 'E（读不了）',
  NOOBS: '?（无观察者）',
  FAIL: 'F（写入失败）',
};

// ---- matrix (pure) -----------------------------------------------------------

export function parseRecords(text) {
  const records = [];
  const parseErrors = [];
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: String(error), text: trimmed.slice(0, 200) });
    }
  });
  return { records, parseErrors };
}

const secondsBetween = (from, to) => {
  const value = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
};

/**
 * A record's result list. Windows PowerShell 5.1's ConvertTo-Json can emit a
 * wrapped array as {"value":[...],"Count":n}; accept that shape too.
 */
export const listOf = (value) =>
  Array.isArray(value) ? value : Array.isArray(value?.value) ? value.value : [];

const emptyBuckets = (names) => Object.fromEntries(names.map((name) => [name, []]));

/**
 * Fold the run's records into the matrix. Record types: meta, plan, reader,
 * writer, manual, read, write, cleanup, note. Later records of the same kind
 * win, so a re-run of one pass simply replaces the earlier one.
 */
export function buildMatrix(records) {
  const all = Array.isArray(records)
    ? records.filter((item) => item && typeof item === 'object')
    : [];
  const ofType = (type) => all.filter((item) => item.type === type);
  const meta = Object.assign({}, ...ofType('meta').map(({ type: _type, ...rest }) => rest));
  const plan = ofType('plan').at(-1) ?? {};
  const marker = plan.marker ?? meta.marker ?? MARKER_PREFIX;
  const items = (plan.items ?? []).map(({ key, name }) => ({ key, name }));
  const manualRecord = ofType('manual').at(-1);
  const manual = {
    requested: manualRecord?.requested === true,
    confirmed: manualRecord?.confirmed === true,
    confirmedAt: manualRecord?.confirmedAt ?? null,
    note: manualRecord?.note ?? null,
  };
  const reads = ofType('read');
  const writes = ofType('write');
  const readerStatus = new Map(ofType('reader').map((item) => [item.id, item]));
  const writerStatus = new Map(ofType('writer').map((item) => [item.id, item]));

  const cells = new Map();
  for (const read of reads) {
    for (const result of listOf(read.results)) {
      const hex = resultHex(result);
      cells.set(`${read.phase}|${read.target}|${read.reader}|${result.key}`, {
        class: resultClass(result, marker),
        hex,
        size: result.size ?? null,
        error: result.error ?? null,
        at: read.at ?? null,
      });
    }
  }
  const cell = (phase, target, reader, key) => cells.get(`${phase}|${target}|${reader}|${key}`);
  const ranReaders = new Set(reads.map((read) => read.reader));

  const readers = (plan.readers ?? READERS).map((def) => {
    const status = readerStatus.get(def.id);
    return {
      id: def.id,
      short: def.short,
      label: def.label,
      available: status ? status.available === true : ranReaders.has(def.id),
      skipReason: status?.skipReason ?? null,
      exe: status?.exe ?? null,
      version: status?.version ?? null,
    };
  });

  const inputMatrix = {};
  const cipherReaders = {};
  const observers = {};
  for (const item of items) {
    const row = {};
    for (const reader of readers)
      row[reader.id] = cell('input', 'in', reader.id, item.key)?.class ?? 'skipped';
    inputMatrix[item.key] = row;
    cipherReaders[item.key] = readers
      .filter((reader) => row[reader.id] === 'ciphertext')
      .map((reader) => reader.id);
    observers[item.key] = manual.confirmed ? cipherReaders[item.key] : [];
  }

  const writers = (plan.writers ?? WRITERS).map((def) => {
    const status = writerStatus.get(def.id);
    const write = writes.filter((item) => item.writer === def.id).at(-1);
    const phases = {};
    for (const phase of PHASES) {
      const phaseReads = reads.filter((read) => read.phase === phase && read.target === def.id);
      const ages = write
        ? phaseReads
            .map((read) => secondsBetween(write.finishedAt, read.at))
            .filter((value) => value !== null)
        : [];
      phases[phase] = {
        ran: phaseReads.length > 0,
        readers: phaseReads.map((read) => read.reader),
        ageMin: ages.length > 0 ? Math.min(...ages) : null,
        ageMax: ages.length > 0 ? Math.max(...ages) : null,
      };
    }
    const outputCells = {};
    for (const item of items) {
      const result = listOf(write?.results).find((entry) => entry.key === item.key);
      const writeOk = write ? result?.ok === true : null;
      const entry = {
        path: result?.path ?? null,
        write: write
          ? {
              ok: writeOk,
              error: result?.error ?? (result ? null : 'no result'),
              detail: result?.detail ?? null,
            }
          : null,
      };
      for (const phase of PHASES) {
        const classes = {};
        for (const reader of readers)
          classes[reader.id] = cell(phase, def.id, reader.id, item.key)?.class ?? 'skipped';
        const verdict =
          !write || !phases[phase].ran ? '-' : verdictOf(observers[item.key], classes, writeOk);
        entry[phase] = { verdict, classes };
      }
      outputCells[item.key] = entry;
    }
    return {
      id: def.id,
      short: def.short,
      label: def.label,
      runner: def.runner,
      mode: def.mode,
      available: status ? status.available === true : Boolean(write),
      skipReason: status?.skipReason ?? null,
      ran: Boolean(write),
      outDir: write?.outDir ?? null,
      startedAt: write?.startedAt ?? null,
      finishedAt: write?.finishedAt ?? null,
      phases,
      cells: outputCells,
    };
  });

  const matrix = {
    kit: 'dsh-rebase P1-13b encryption matrix',
    generatedAt: new Date().toISOString(),
    meta,
    manual,
    marker,
    items,
    readers,
    writers,
    inputMatrix,
    cipherReaders,
    observers,
  };
  matrix.facts = computeFacts(matrix, cell);
  matrix.notes = ofType('note').map(({ type: _type, ...rest }) => rest);
  matrix.cleanup = Object.assign({}, ...ofType('cleanup').map(({ type: _type, ...rest }) => rest));
  return matrix;
}

function computeFacts(matrix, cell) {
  const { items, readers, writers, inputMatrix, observers } = matrix;
  const classNames = Object.keys(CLASS_NAME);
  const inputsByReader = {};
  for (const reader of readers) {
    const buckets = emptyBuckets(classNames);
    for (const item of items) buckets[inputMatrix[item.key][reader.id]].push(item.key);
    inputsByReader[reader.id] = buckets;
  }
  const inputOthers = [];
  for (const item of items) {
    for (const reader of readers) {
      const found = cell('input', 'in', reader.id, item.key);
      if (found && (found.class === 'other' || found.class === 'error')) {
        inputOthers.push({
          key: item.key,
          reader: reader.id,
          class: found.class,
          preview: asciiPreview(found.hex ?? ''),
          error: found.error,
        });
      }
    }
  }
  const pairs = [];
  const ran = (id) => items.some((item) => inputMatrix[item.key][id] !== 'skipped');
  for (const [a, b] of [
    ['R-node', 'R-renamed'],
    ['R-node', 'R-electron'],
  ]) {
    if (!ran(a) || !ran(b)) {
      pairs.push({ a, b, compared: false });
      continue;
    }
    const differ = items
      .filter((item) => inputMatrix[item.key][a] !== inputMatrix[item.key][b])
      .map((item) => ({ key: item.key, a: inputMatrix[item.key][a], b: inputMatrix[item.key][b] }));
    pairs.push({ a, b, compared: true, same: items.length - differ.length, differ });
  }
  const covered = items.filter((item) => observers[item.key].length > 0).map((item) => item.key);
  const uncovered = items
    .filter((item) => observers[item.key].length === 0)
    .map((item) => item.key);
  const verdictNames = [...Object.keys(VERDICT_CODE)];
  const writerFacts = {};
  for (const writer of writers) {
    const byPhase = {};
    for (const phase of PHASES) {
      const buckets = emptyBuckets(verdictNames);
      for (const item of items) buckets[writer.cells[item.key][phase].verdict].push(item.key);
      byPhase[phase] = buckets;
    }
    const changed = items
      .filter((item) => {
        const { immediate, delayed } = writer.cells[item.key];
        return (
          immediate.verdict !== '-' &&
          delayed.verdict !== '-' &&
          immediate.verdict !== delayed.verdict
        );
      })
      .map((item) => ({
        key: item.key,
        from: writer.cells[item.key].immediate.verdict,
        to: writer.cells[item.key].delayed.verdict,
      }));
    const failures = items
      .filter((item) => writer.cells[item.key].write?.ok === false)
      .map((item) => ({ key: item.key, error: writer.cells[item.key].write.error }));
    const editNotApplied = items
      .filter((item) => writer.cells[item.key].write?.detail?.editApplied === false)
      .map((item) => item.key);
    writerFacts[writer.id] = { ran: writer.ran, ...byPhase, changed, failures, editNotApplied };
  }
  return {
    inputsByReader,
    inputOthers,
    pairs,
    observerCoverage: { covered, uncovered },
    writers: writerFacts,
  };
}

// ---- summary (pure) ------------------------------------------------------------

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index]).length))
  );
  const format = (cells) =>
    cells
      .map((value, index) => String(value).padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [format(headers), ...rows.map(format)];
}

const list = (keys) => (keys.length === 0 ? '无' : keys.join(', '));
const yesNo = (value) => (value === true ? '是' : value === false ? '否' : '未知');

function ageRange(phase) {
  if (!phase.ran) return '未跑';
  if (phase.ageMin === null) return '已跑';
  return phase.ageMin === phase.ageMax
    ? `写完后约 ${phase.ageMin} 秒`
    : `写完后约 ${phase.ageMin}～${phase.ageMax} 秒`;
}

export function renderSummary(matrix) {
  const { meta, manual, items, readers, writers, inputMatrix, observers, cipherReaders, facts } =
    matrix;
  const lines = [];
  const push = (...values) => lines.push(...values);
  push(`P1-13b 加密矩阵上机结果  ${meta.finishedAt ?? matrix.generatedAt}`);
  if (meta.mode === 'rehearsal') {
    push(
      '模式：Linux 预演（rehearsal）。数据来自本机临时目录与人为伪造的 TSD 头，不是加密机结果，不能当结论。'
    );
  }
  push('');

  push('== 机器');
  push(`系统：${meta.os ?? '?'}；PowerShell ${meta.psVersion ?? '?'}`);
  push(`管理员：${yesNo(meta.isAdmin)}；EnableLUA=${meta.enableLua ?? '?'}`);
  push(`随包 node.exe：${meta.nodeExe ?? '?'}（${meta.nodeVersion ?? '?'}）`);
  push(`应用版本：${meta.appVersion ?? '?'}；应用目录：${meta.appDir ?? '?'}`);
  push(
    meta.electronExe
      ? `Electron 主程序：${meta.electronExe}（Electron ${meta.electronVersion ?? '?'}，内嵌 Node ${meta.electronNode ?? '?'}）`
      : `Electron 主程序：未用（${meta.electronSkip ?? '没找到'}）`
  );
  push(
    meta.renamedExe
      ? `改名副本：${meta.renamedExe}（与 node.exe 的 sha256 ${meta.renamedSameHash === true ? '相同' : meta.renamedSameHash === false ? '不同' : '未比对'}）`
      : `改名副本：未用（${meta.renamedSkip ?? '?'}）`
  );
  push(`加密目录：${meta.encDir ?? '?'}；工作目录：${meta.work ?? '?'}`);
  push(`标记：${matrix.marker}；延迟复读间隔：${meta.delaySeconds ?? '?'} 秒`);
  push(
    manual.confirmed
      ? `人工加密确认：已确认（${manual.confirmedAt}）${manual.note ? `；用户备注：${manual.note}` : ''}`
      : manual.requested
        ? '人工加密确认：已请求但没有确认。'
        : '人工加密确认：未请求（没加 -ManualEncryption），输入是否已加密没有人工证据。'
  );
  push('');

  push('== 读者');
  for (const reader of readers) {
    const state = reader.available ? '可用' : `跳过：${reader.skipReason ?? '未测'}`;
    push(
      `${reader.id.padEnd(11)} ${state}${reader.exe ? `  ${reader.exe}` : ''}${reader.version ? `（${reader.version}）` : ''}`
    );
  }
  push('');

  push('== 输入矩阵：文件类型 × 读者（输入由 PowerShell 创建，随后人工加密）');
  push('图例：P 读到明文标记；C 读到 TSD 头；O 其他内容；M 文件不存在；E 读取出错；- 该读者未测');
  push(
    ...renderTable(
      ['type', ...readers.map((reader) => reader.short)],
      items.map((item) => [
        item.key,
        ...readers.map((reader) => CLASS_CODE[inputMatrix[item.key][reader.id]]),
      ])
    )
  );
  push('');

  push('== 有效观察者（对人工确认已加密的输入读到 TSD 头的读者）');
  if (!manual.confirmed) {
    push('输入没有经过人工确认，有效观察者一个都不算。下面只列出对输入读到 TSD 头的读者，供参考：');
    for (const item of items) {
      if (cipherReaders[item.key].length > 0)
        push(`${item.key.padEnd(22)} ${cipherReaders[item.key].join(', ')}`);
    }
  } else {
    for (const item of items) {
      if (observers[item.key].length > 0)
        push(`${item.key.padEnd(22)} ${observers[item.key].join(', ')}`);
    }
  }
  const { covered, uncovered } = facts.observerCoverage;
  push(`覆盖：${covered.length} / ${items.length} 个类型有有效观察者。`);
  if (uncovered.length > 0) push(`没有有效观察者（只能靠人工确认）：${list(uncovered)}`);
  if (covered.length === 0) {
    push('本轮没有任何读者对人工确认已加密的输入读到 TSD 头：所有输出是否加密只能靠人工确认。');
  }
  push('');

  push('== 输出矩阵：文件类型 × 写者（有效观察者眼里；每格「立即/延迟」）');
  push(
    '图例：C 有效观察者都读到 TSD 头；P 都读到明文标记；X 观察者之间不一致；O 都读到其他内容；E 观察者都读不了；? 该类型没有有效观察者（只能靠人工确认）；F 写入失败；- 写者或该次复读没跑'
  );
  for (const writer of writers) {
    const state = writer.ran
      ? `立即复读 ${ageRange(writer.phases.immediate)}；延迟复读 ${ageRange(writer.phases.delayed)}`
      : `没跑：${writer.skipReason ?? '未知'}`;
    push(`${writer.short.padEnd(8)} = ${writer.id}：${writer.label}。${state}`);
  }
  push(
    ...renderTable(
      ['type', ...writers.map((writer) => writer.short)],
      items.map((item) => [
        item.key,
        ...writers.map((writer) => {
          const found = writer.cells[item.key];
          return `${VERDICT_CODE[found.immediate.verdict]}/${VERDICT_CODE[found.delayed.verdict]}`;
        }),
      ])
    )
  );
  push('');

  push('== 结论（只陈述观察到的事实，不做推断）');
  push(
    `1. 人工加密确认：${manual.confirmed ? `已确认，时间 ${manual.confirmedAt}` : manual.requested ? '已请求但没有确认' : '未请求'}。`
  );
  push(`2. 各读者读输入（共 ${items.length} 个类型）：`);
  for (const reader of readers) {
    const buckets = facts.inputsByReader[reader.id];
    if (!reader.available && buckets.skipped.length === items.length) {
      push(`   - ${reader.id}：跳过（${reader.skipReason ?? '未测'}）`);
      continue;
    }
    push(
      `   - ${reader.id}：明文 ${buckets.plaintext.length}（${list(buckets.plaintext)}）；TSD 头 ${buckets.ciphertext.length}（${list(buckets.ciphertext)}）；其他 ${buckets.other.length}（${list(buckets.other)}）；不存在 ${buckets.missing.length}；出错 ${buckets.error.length}（${list(buckets.error)}）；未测 ${buckets.skipped.length}`
    );
  }
  push('3. 读者对照（输入）：');
  for (const pair of facts.pairs) {
    if (!pair.compared) {
      push(`   - ${pair.a} 与 ${pair.b}：没法对照（至少一方没读输入）。`);
      continue;
    }
    const differ = pair.differ.map(
      (entry) =>
        `${entry.key}（${pair.a}=${CLASS_CODE[entry.a]}，${pair.b}=${CLASS_CODE[entry.b]}）`
    );
    push(
      `   - ${pair.a} 与 ${pair.b}：${items.length} 个类型中 ${pair.same} 个结果相同；不同：${list(differ)}`
    );
  }
  push(
    `4. 有效观察者覆盖 ${covered.length} / ${items.length} 个类型；没有有效观察者的类型：${list(uncovered)}`
  );
  push('5. 各写者的输出（有效观察者眼里）：');
  for (const writer of writers) {
    const found = facts.writers[writer.id];
    if (!found.ran) {
      push(`   - ${writer.id}：没跑（${writer.skipReason ?? '未知'}）`);
      continue;
    }
    // Non-empty buckets only; types without observers are counted, not listed.
    const phaseText = (phase) =>
      ['ENC', 'PLAIN', 'MIX', 'OTHER', 'ERR', 'FAIL', 'NOOBS']
        .filter((name) => found[phase][name].length > 0)
        .map((name) =>
          name === 'NOOBS'
            ? `${VERDICT_NAME[name]} ${found[phase][name].length}`
            : `${VERDICT_NAME[name]} ${found[phase][name].length}（${found[phase][name].join(', ')}）`
        )
        .join('；') || '无';
    push(`   - ${writer.id}：`);
    push(`     立即：${phaseText('immediate')}`);
    push(`     延迟：${phaseText('delayed')}`);
    push(
      `     立即与延迟不同：${list(found.changed.map((entry) => `${entry.key}（${VERDICT_CODE[entry.from]}→${VERDICT_CODE[entry.to]}）`))}`
    );
    if (found.editNotApplied.length > 0) {
      push(
        `     读出的内容里没有「${EDIT_NEEDLE}」、没有改写的类型：${list(found.editNotApplied)}`
      );
    }
  }
  const failures = writers.flatMap((writer) =>
    facts.writers[writer.id].failures.map((entry) => `${writer.id} ${entry.key}：${entry.error}`)
  );
  push(`6. 写入失败：${failures.length === 0 ? '无' : ''}`);
  for (const entry of failures) push(`   - ${entry}`);
  push('');

  push('== 需要人工确认');
  if (!manual.confirmed) {
    push('- 输入没有经过人工确认加密：上面的结论都不能当作「这些类型已加密」的证据。');
  }
  if (uncovered.length === 0) {
    push('- 每个类型都有有效观察者，输出矩阵不需要逐个人工确认。');
  } else {
    const ranWriters = writers.filter((writer) => writer.ran);
    push(
      `- 下面 ${uncovered.length} 个类型没有有效观察者，脚本判断不了输出是否加密。请用加密客户端（文件图标、右键属性或客户端自带的查看功能）查看：`
    );
    push(
      `  文件名：${uncovered.map((key) => items.find((item) => item.key === key)?.name ?? key).join(', ')}`
    );
    push('  目录（每个目录下都有这些同名文件）：');
    for (const writer of ranWriters) push(`    ${writer.outDir ?? writer.id}`);
    const priority = MANUAL_PRIORITY.filter((key) => uncovered.includes(key));
    if (priority.length > 0) {
      push(`  逐个看不过来时，至少看这几个类型：${priority.join(', ')}`);
    }
    push('  回报时按「目录 → 哪些文件未加密」记下即可。');
  }
  push('');

  push('== 明细：每个输出文件在各读者眼里（立即 | 延迟）');
  push(`读者顺序：${readers.map((reader) => reader.short).join(' ')}；代码同输入矩阵`);
  for (const writer of writers) {
    if (!writer.ran) continue;
    push(`-- ${writer.id}（${writer.outDir ?? ''}）`);
    const codes = (classes) => readers.map((reader) => CLASS_CODE[classes[reader.id]]).join('');
    push(
      ...renderTable(
        ['type', 'immediate', 'delayed', 'write'],
        items.map((item) => {
          const found = writer.cells[item.key];
          const write =
            found.write?.ok === false
              ? `失败：${found.write.error}`
              : found.write?.detail?.editApplied === false
                ? '编辑未生效'
                : 'ok';
          return [item.key, codes(found.immediate.classes), codes(found.delayed.classes), write];
        })
      )
    );
  }
  push('');

  push('== 输入里读到其他内容或出错的（前 32 字节预览）');
  if (facts.inputOthers.length === 0) push('无');
  for (const entry of facts.inputOthers.slice(0, 120)) {
    push(
      `${entry.key.padEnd(22)} ${entry.reader.padEnd(11)} ${entry.class === 'error' ? `出错：${entry.error}` : `「${entry.preview}」`}`
    );
  }
  push('');

  push('== 清理');
  const cleanup = matrix.cleanup ?? {};
  push(`改名副本：${cleanup.renamedExe ?? '?'}`);
  push(`%TEMP% 下的临时目录：${cleanup.tempRoot ?? '?'}`);
  push(`工作目录：${cleanup.work ?? '?'}`);
  for (const note of matrix.notes ?? []) push(`注记：${note.text ?? JSON.stringify(note)}`);
  push('');
  push(
    '请把整个 report-p113b-<时间> 目录发回（matrix.json、summary.txt、probe.log，以及 manual-encryption-*）。'
  );
  return lines.join('\n');
}

// ---- file primitives -------------------------------------------------------------

const describeError = (error) =>
  error && typeof error === 'object' && 'code' in error && error.code
    ? `${error.code}: ${error.message}`
    : String(error?.message ?? error);

/** First `limit` bytes of a file as this process sees them. */
export function readHead(path, limit = HEAD_BYTES) {
  const result = { path, exists: false, size: null, hex: null, error: null };
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    result.exists = existsSync(path);
    result.error = describeError(error);
    return result;
  }
  result.exists = true;
  try {
    result.size = fstatSync(fd).size;
    const buffer = Buffer.alloc(limit);
    const count = readSync(fd, buffer, 0, limit, 0);
    result.hex = buffer.subarray(0, count).toString('hex');
  } catch (error) {
    result.error = describeError(error);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  return result;
}

/**
 * The staging layout DSH's LocalFileSystem uses (dsh-fs-local writeFileAtomic):
 * a hidden `.<name>.<pid>.<uuid>.tmpdir` sibling holding `<name>.tmp`, opened
 * with exclusive create and synced before it is published.
 */
function stageTemp(target, content) {
  const stagingDir = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmpdir`
  );
  mkdirSync(stagingDir, { mode: 0o700 });
  const temp = join(stagingDir, `${basename(target)}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { stagingDir, temp };
}

export function writeOne(mode, target, source, content, writerId) {
  switch (mode) {
    case 'create':
      if (existsSync(target)) throw new Error(`target already exists: ${target}`);
      // Flag 'w', as the 1.0.x write tool (src/runtime/host/io.ts) opens files.
      writeFileSync(target, content);
      return null;
    case 'dsh-create': {
      // DSH write publishes an unseen file with link(temp, target) (createIfAbsent).
      const { stagingDir, temp } = stageTemp(target, content);
      try {
        linkSync(temp, target);
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }
      return { published: 'hardlink', staging: basename(stagingDir) };
    }
    case 'rename': {
      const { stagingDir, temp } = stageTemp(target, content);
      try {
        renameSync(temp, target);
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }
      return { published: 'rename', staging: basename(stagingDir) };
    }
    case 'copy-only':
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      return { source };
    case 'copy-then-write':
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      writeFileSync(target, content);
      return { source };
    case 'edit-existing': {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      const before = readFileSync(target);
      const text = before.toString('utf8');
      if (!text.includes(EDIT_NEEDLE)) {
        return { source, editApplied: false, headBefore: before.subarray(0, 16).toString('hex') };
      }
      writeFileSync(target, text.replace(EDIT_NEEDLE, `edited by ${writerId}`));
      return { source, editApplied: true };
    }
    default:
      throw new Error(`unknown write mode: ${mode}`);
  }
}

// ---- commands --------------------------------------------------------------------

const now = () => new Date().toISOString();

export const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

const reply = (value) => process.stdout.write(`${asciiJson(value)}\n`);

export function identity() {
  return {
    pid: process.pid,
    execPath: process.execPath,
    node: process.version,
    electron: process.versions.electron ?? null,
    platform: process.platform,
    arch: process.arch,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  };
}

function countClasses(results, marker) {
  const counts = {};
  for (const result of results) {
    const name = resultClass(result, marker);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export function readCommand(request) {
  const at = now();
  const results = (request.items ?? []).map((item) => ({ key: item.key, ...readHead(item.path) }));
  return {
    type: 'read',
    reader: request.reader,
    phase: request.phase,
    target: request.target,
    at,
    finishedAt: now(),
    process: identity(),
    counts: countClasses(results, request.marker),
    results,
  };
}

export function writeCommand(request) {
  const startedAt = now();
  mkdirSync(request.outDir, { recursive: true });
  const results = (request.items ?? []).map((item) => {
    const path = join(request.outDir, item.name);
    const content = writerContent(request.marker, item.key, request.writer);
    try {
      const detail = writeOne(request.mode, path, item.source, content, request.writer);
      return { key: item.key, path, ok: true, error: null, detail, at: now() };
    } catch (error) {
      return {
        key: item.key,
        path,
        ok: false,
        error: describeError(error),
        detail: null,
        at: now(),
      };
    }
  });
  return {
    type: 'write',
    writer: request.writer,
    mode: request.mode,
    outDir: request.outDir,
    startedAt,
    finishedAt: now(),
    process: identity(),
    results,
  };
}

function planReply() {
  const marker = newMarker();
  return {
    ok: true,
    type: 'plan',
    marker,
    headBytes: HEAD_BYTES,
    tsdMagic: TSD_MAGIC,
    items: planItems(marker),
    readers: READERS,
    writers: WRITERS,
    process: identity(),
  };
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

const optionFrom = (argv, name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

export function writeReport(outDir, matrix, records) {
  mkdirSync(outDir, { recursive: true });
  const matrixFile = join(outDir, 'matrix.json');
  const summaryFile = join(outDir, 'summary.txt');
  writeFileSync(matrixFile, `${JSON.stringify({ ...matrix, records }, null, 2)}\n`);
  // BOM + CRLF so Notepad on the Windows box shows the Chinese text as is.
  writeFileSync(summaryFile, `\uFEFF${renderSummary(matrix).replace(/\n/g, '\r\n')}\r\n`);
  return { matrixFile, summaryFile };
}

async function reportCommand(argv) {
  const outDir = optionFrom(argv, 'out-dir');
  if (!outDir) throw new Error('report needs --out-dir <dir>');
  const { records, parseErrors } = parseRecords(await readStdin());
  const matrix = buildMatrix(records);
  matrix.parseErrors = parseErrors;
  const files = writeReport(outDir, matrix, records);
  reply({ ok: true, ...files, records: records.length, parseErrors: parseErrors.length });
}

// ---- rehearsal (Linux dry run) ------------------------------------------------

const SELF = fileURLToPath(import.meta.url);
/** Types whose rehearsal inputs are overwritten with a fake TSD container. */
const REHEARSAL_ENCRYPTED = Object.freeze(['txt', 'yml', 'docx', 'session.v4.jsonl.zstd']);
/** Output the rehearsal "encrypts" between the immediate and the delayed read. */
const REHEARSAL_LATE = Object.freeze({ writer: 'W-node-create', key: 'txt' });

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fakeTsd = () => Buffer.concat([Buffer.from(TSD_MAGIC, 'latin1'), randomBytes(48)]);

function callProbe(exe, command, request) {
  const env = { ...process.env, P113B_REQUEST: JSON.stringify(request) };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(exe, [SELF, command], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = String(run.stdout ?? '')
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith('{'))
    .at(-1);
  let parsed = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {}
  return {
    status: run.status,
    error: run.error ? String(run.error) : null,
    stderr: String(run.stderr ?? '').slice(0, 2000),
    reply: parsed,
  };
}

const stampNow = () => {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** Expectations the rehearsal's synthetic data must meet; returns failed checks. */
export function rehearsalChecks(matrix, summary) {
  const failed = [];
  const expect = (condition, text) => {
    if (!condition) failed.push(text);
  };
  const writer = (id) => matrix.writers.find((entry) => entry.id === id);
  const verdicts = (id, key) => {
    const found = writer(id)?.cells[key];
    return found ? `${found.immediate.verdict}/${found.delayed.verdict}` : 'none';
  };
  expect(matrix.manual.confirmed === true, 'manual confirmation recorded');
  for (const item of matrix.items) {
    const encrypted = REHEARSAL_ENCRYPTED.includes(item.key);
    const expected = encrypted ? 'R-node,R-renamed' : '';
    expect(
      matrix.observers[item.key].join(',') === expected,
      `observers of ${item.key} = [${expected}]`
    );
    expect(
      matrix.inputMatrix[item.key]['R-node'] === (encrypted ? 'ciphertext' : 'plaintext'),
      `R-node input class of ${item.key}`
    );
    expect(matrix.inputMatrix[item.key]['R-ps51'] === 'skipped', `R-ps51 skipped for ${item.key}`);
    if (!encrypted)
      expect(verdicts('W-node-create', item.key) === 'NOOBS/NOOBS', `NOOBS for ${item.key}`);
  }
  for (const key of REHEARSAL_ENCRYPTED) {
    const late = key === REHEARSAL_LATE.key;
    expect(
      verdicts('W-node-create', key) === (late ? 'PLAIN/ENC' : 'PLAIN/PLAIN'),
      `W-node-create ${key}`
    );
    for (const id of [
      'W-node-dsh-create',
      'W-node-rename',
      'W-node-copy-then-write',
      'W-renamed-create',
    ]) {
      expect(verdicts(id, key) === 'PLAIN/PLAIN', `${id} ${key}`);
    }
    expect(verdicts('W-node-copy', key) === 'ENC/ENC', `W-node-copy ${key}`);
    expect(verdicts('W-node-edit-existing', key) === 'ENC/ENC', `W-node-edit-existing ${key}`);
    expect(
      writer('W-node-edit-existing')?.cells[key].write?.detail?.editApplied === false,
      `edit not applied on fake container ${key}`
    );
  }
  expect(
    writer('W-node-edit-existing')?.cells.md.write?.detail?.editApplied === true,
    'edit applied on plaintext md'
  );
  for (const id of ['W-electron-create', 'W-ps51']) {
    expect(writer(id)?.ran === false && verdicts(id, 'txt') === '-/-', `${id} not run`);
  }
  expect(
    matrix.facts.writers['W-node-create'].changed.some(
      (entry) => entry.key === 'txt' && entry.to === 'ENC'
    ),
    'late encryption listed as a change'
  );
  const pair = matrix.facts.pairs.find((entry) => entry.b === 'R-renamed');
  expect(pair?.compared === true && pair.differ.length === 0, 'R-node and R-renamed agree');
  for (const heading of [
    '== 输入矩阵',
    '== 有效观察者',
    '== 输出矩阵',
    '== 结论',
    '只能靠人工确认',
    '== 明细',
  ]) {
    expect(summary.includes(heading), `summary has ${heading}`);
  }
  return failed;
}

async function rehearsal(argv) {
  const delay = Number(optionFrom(argv, 'delay', '2'));
  const keep = argv.includes('--keep');
  const stamp = stampNow();
  const base = mkdtempSync(join(tmpdir(), 'p113b-rehearsal-'));
  const encDir = join(base, 'enc');
  const work = join(encDir, `p113b-${stamp}`);
  const inDir = join(work, 'in');
  const tempRoot = join(base, `p113b-${stamp}`);
  const reportDir = resolve(optionFrom(argv, 'out', join(base, `report-p113b-${stamp}`)));
  mkdirSync(reportDir, { recursive: true });
  const logFile = join(reportDir, 'probe.log');
  const log = (text) => {
    const line = `[${new Date().toISOString()}] ${text}`;
    process.stderr.write(`[p113b rehearsal] ${text}\n`);
    appendFileSync(logFile, `${line}\n`);
  };
  const records = [];
  const nodeExe = process.execPath;

  log(`base ${base}; delay ${delay}s`);
  const ping = callProbe(nodeExe, 'ping', {});
  const plan = callProbe(nodeExe, 'plan', {}).reply;
  if (!ping.reply?.ok || !plan?.ok) throw new Error(`probe did not answer: ${ping.stderr}`);
  const { marker, items } = plan;
  records.push({ type: 'plan', marker, items, readers: plan.readers, writers: plan.writers });

  mkdirSync(tempRoot, { recursive: true });
  const renamedExe = join(tempRoot, process.platform === 'win32' ? 'p113b-raw.exe' : 'p113b-raw');
  copyFileSync(nodeExe, renamedExe);
  chmodSync(renamedExe, 0o755);
  const renamedPing = callProbe(renamedExe, 'ping', {});
  const exes = { node: nodeExe, renamed: renamedPing.reply?.ok ? renamedExe : null };
  log(
    `renamed copy ${renamedExe}: ${renamedPing.reply?.ok ? 'ok' : `failed ${renamedPing.stderr}`}`
  );

  records.push({
    type: 'meta',
    mode: 'rehearsal',
    stamp,
    startedAt: now(),
    os: `${osType()} ${osRelease()}`,
    psVersion: '无（Linux 预演）',
    isAdmin: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
    enableLua: '不适用',
    appDir: '不适用（Linux 预演）',
    appVersion: 'rehearsal',
    nodeExe,
    nodeVersion: process.version,
    electronExe: null,
    electronSkip: 'Linux 预演没有 Electron 主程序',
    renamedExe: exes.renamed,
    renamedSkip: exes.renamed ? null : 'copy did not start',
    renamedSameHash: sha256(renamedExe) === sha256(nodeExe),
    encDir,
    work,
    kitDir: dirname(SELF),
    temp: tempRoot,
    delaySeconds: delay,
    marker,
  });
  const readerExe = { 'R-node': exes.node, 'R-renamed': exes.renamed };
  for (const reader of READERS) {
    const exe = readerExe[reader.id];
    records.push({
      type: 'reader',
      id: reader.id,
      available: Boolean(exe),
      exe: exe ?? null,
      skipReason: exe ? null : 'Linux 预演没有这个读者',
    });
  }
  const writerExe = { node: exes.node, renamed: exes.renamed };
  for (const writer of WRITERS) {
    const exe = writerExe[writer.runner];
    records.push({
      type: 'writer',
      id: writer.id,
      available: Boolean(exe),
      skipReason: exe ? null : 'Linux 预演没有这个写者',
    });
  }

  // Inputs: PowerShell's job on the box; here the rehearsal writes them, then
  // turns a few into fake TSD containers in place of the manual encryption.
  mkdirSync(inDir, { recursive: true });
  for (const item of items) writeFileSync(join(inDir, item.name), `${item.content}\r\n`);
  for (const key of REHEARSAL_ENCRYPTED) {
    writeFileSync(join(inDir, items.find((item) => item.key === key).name), fakeTsd());
  }
  records.push({
    type: 'manual',
    requested: true,
    confirmed: true,
    confirmedAt: now(),
    note: `rehearsal：${REHEARSAL_ENCRYPTED.join('、')} 被替换成伪造的 TSD 头文件，其余保持明文`,
  });
  const inputItems = items.map((item) => ({ key: item.key, path: join(inDir, item.name) }));

  const readPass = (phase, target, passItems) => {
    for (const [reader, exe] of Object.entries(readerExe)) {
      if (!exe) continue;
      const run = callProbe(exe, 'read', { reader, phase, target, marker, items: passItems });
      if (run.reply?.type === 'read') {
        records.push(run.reply);
        log(`${phase} ${target} ${reader}: ${JSON.stringify(run.reply.counts)}`);
      } else {
        log(`${phase} ${target} ${reader}: no reply (${run.error ?? run.stderr})`);
      }
    }
  };

  readPass('input', 'in', inputItems);
  const outputs = [];
  for (const writer of WRITERS) {
    const exe = writerExe[writer.runner];
    if (!exe) continue;
    const outDir = join(work, `out-${writer.id}`);
    const run = callProbe(exe, 'write', {
      writer: writer.id,
      mode: writer.mode,
      outDir,
      marker,
      items: items.map((item) => ({
        key: item.key,
        name: item.name,
        source: join(inDir, item.name),
      })),
    });
    if (run.reply?.type !== 'write') {
      log(`${writer.id}: no reply (${run.error ?? run.stderr})`);
      continue;
    }
    records.push(run.reply);
    const failed = run.reply.results.filter((result) => !result.ok).length;
    log(`${writer.id}: wrote ${run.reply.results.length - failed}, failed ${failed}`);
    const outItems = items.map((item) => ({ key: item.key, path: join(outDir, item.name) }));
    readPass('immediate', writer.id, outItems);
    if (writer.id === REHEARSAL_LATE.writer) {
      writeFileSync(
        join(outDir, items.find((item) => item.key === REHEARSAL_LATE.key).name),
        fakeTsd()
      );
    }
    outputs.push({ writer: writer.id, items: outItems });
  }
  log(`waiting ${delay}s before the delayed read`);
  await new Promise((resolveWait) => setTimeout(resolveWait, delay * 1000));
  for (const output of outputs) readPass('delayed', output.writer, output.items);

  rmSync(tempRoot, { recursive: true, force: true });
  if (!keep) rmSync(encDir, { recursive: true, force: true });
  records.push({
    type: 'cleanup',
    renamedExe: existsSync(renamedExe) ? `没删掉：${renamedExe}` : '已删除',
    tempRoot: existsSync(tempRoot) ? `没删掉：${tempRoot}` : '已删除',
    work: keep ? `已保留：${work}` : '已删除（预演）',
  });
  records.push({ type: 'meta', finishedAt: now() });

  const report = spawnSync(nodeExe, [SELF, 'report', '--out-dir', reportDir], {
    input: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (report.status !== 0) throw new Error(`report failed: ${report.stderr}`);
  const matrix = JSON.parse(readFileSync(join(reportDir, 'matrix.json'), 'utf8'));
  const summary = readFileSync(join(reportDir, 'summary.txt'), 'utf8');
  const failed = rehearsalChecks(matrix, summary);
  if (!summary.startsWith('\uFEFF')) failed.push('summary.txt starts with a BOM');
  log(`report ${reportDir}; ${matrix.records.length} records`);
  for (const text of failed) log(`CHECK FAILED: ${text}`);
  log(`rehearsal checks: ${failed.length === 0 ? 'all passed' : `${failed.length} failed`}`);
  // The base only holds the report now; drop it when the report went elsewhere.
  if (!keep && !reportDir.startsWith(`${base}/`)) rmSync(base, { recursive: true, force: true });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// ---- entry ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--rehearsal')) return rehearsal(argv);
  const command = argv[0];
  if (command === 'report') return reportCommand(argv);
  let request = {};
  try {
    request = JSON.parse(process.env.P113B_REQUEST || '{}');
  } catch (error) {
    reply({ ok: false, error: `bad P113B_REQUEST: ${describeError(error)}`, process: identity() });
    process.exitCode = 2;
    return;
  }
  switch (command) {
    case 'ping':
      return reply({ ok: true, type: 'ping', process: identity() });
    case 'plan':
      return reply(planReply());
    case 'read':
      return reply(readCommand(request));
    case 'write':
      return reply(writeCommand(request));
    default:
      process.stderr.write(
        'usage: matrix-probe.mjs ping|plan|read|write|report --out-dir <dir>|--rehearsal\n'
      );
      process.exitCode = 2;
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(SELF);
    const invoked = realpathSync(resolve(process.argv[1]));
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[matrix-probe] ${error?.stack ?? error}\n`);
    reply({ ok: false, error: describeError(error), process: identity() });
    process.exitCode = 1;
  });
}
