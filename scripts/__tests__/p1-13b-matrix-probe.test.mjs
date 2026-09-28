import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asciiJson,
  buildMatrix,
  classifyBytes,
  classifyHex,
  EXTENSIONS,
  parseCertutilDump,
  parseRecords,
  planItems,
  READERS,
  renderSummary,
  resultClass,
  TSD_MAGIC,
  verdictOf,
  WRITERS,
  writeOne,
} from '../../src/dsh-host/tools/p1-13b/matrix-probe.mjs';

/**
 * P1-13b encryption matrix probe: the pure pieces (classification, certutil
 * parsing, verdicts, matrix and summary) and the node writer modes.
 *
 * Lives under scripts/__tests__ because it imports an untyped .mjs, which tsc
 * rejects inside src/ (same reason as node-runtime-pin.test.mjs).
 */

const MARKER = 'P113B-MARKER-0badf00d';
const hexOf = (text) => Buffer.from(text, 'latin1').toString('hex');
const TSD_HEX = hexOf(`${TSD_MAGIC}\u0001\u0002binary`);

describe('planItems', () => {
  it('covers every requested extension plus the whole-name files, once each', () => {
    const items = planItems(MARKER);
    const names = items.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const ext of ['txt', 'yml', 'ts', 'ps1', 'docx', 'pdf', 'lock', 'patch']) {
      expect(names).toContain(`p113b.${ext}`);
    }
    for (const name of ['Makefile', 'Dockerfile', 'README', '.env', 'session.v4.jsonl.zstd']) {
      expect(names).toContain(name);
    }
    expect(items).toHaveLength(EXTENSIONS.length + 5);
    expect(items.find((item) => item.key === 'txt')?.content).toBe(`${MARKER} txt plaintext line`);
  });
});

describe('classification', () => {
  it('reads the TSD header as ciphertext, the run marker as plaintext, anything else as other', () => {
    expect(classifyHex(TSD_HEX, MARKER)).toBe('ciphertext');
    expect(classifyHex(hexOf(`${MARKER} txt plaintext line\r\n`), MARKER)).toBe('plaintext');
    expect(classifyHex(hexOf('P113B-MARKER-deadbeef txt plaintext line'), MARKER)).toBe('other');
    expect(classifyHex('', MARKER)).toBe('other');
    expect(classifyBytes(Buffer.from([0xff, 0xfe, 0x00]), MARKER)).toBe('other');
  });

  it('prefers ciphertext when both strings appear', () => {
    expect(classifyHex(hexOf(`${TSD_MAGIC}${MARKER}`), MARKER)).toBe('ciphertext');
  });

  it('maps reader results to missing / error / a class', () => {
    expect(resultClass({ exists: false }, MARKER)).toBe('missing');
    expect(resultClass({ exists: true, error: 'EPERM: denied' }, MARKER)).toBe('error');
    expect(resultClass({ exists: true, hex: null }, MARKER)).toBe('error');
    expect(resultClass(undefined, MARKER)).toBe('skipped');
    expect(resultClass({ exists: true, hex: TSD_HEX }, MARKER)).toBe('ciphertext');
  });
});

describe('parseCertutilDump', () => {
  const dump = [
    '  0000  25 54 53 44 2d 48 65 61  64 65 72 2d 23 23 23 25   %TSD-Header-###%',
    '  0010  01 02 03 04 05 06 07 08  09 0a 0b 0c 0d 0e 0f 10   ................',
    '  0020  61 62                                              ab',
    'CertUtil: -dump 命令成功完成。',
  ].join('\r\n');

  it('collects the byte pairs from contiguous rows and stops at the ASCII column', () => {
    const hex = parseCertutilDump(dump);
    expect(hex?.length).toBe(34 * 2);
    expect(hex?.endsWith('6162')).toBe(true);
    expect(classifyHex(hex, MARKER)).toBe('ciphertext');
  });

  it('keeps only the first 64 bytes and ignores non-dump lines', () => {
    const rows = Array.from({ length: 6 }, (_, row) => {
      const offset = (row * 16).toString(16).padStart(4, '0');
      const pairs = Array.from({ length: 16 }, () => '41');
      return `  ${offset}  ${pairs.slice(0, 8).join(' ')}  ${pairs.slice(8).join(' ')}   AAAAAAAAAAAAAAAA`;
    });
    expect(parseCertutilDump(['header', ...rows].join('\n'))).toBe('41'.repeat(64));
    expect(parseCertutilDump('CertUtil: 错误')).toBeNull();
  });

  it('feeds resultClass when a reader only has the raw dump', () => {
    expect(resultClass({ exists: true, certutilDump: dump }, MARKER)).toBe('ciphertext');
  });
});

describe('verdictOf', () => {
  it('judges an output by the type’s effective observers only', () => {
    const classes = {
      'R-node': 'plaintext',
      'R-renamed': 'ciphertext',
      'R-certutil': 'ciphertext',
    };
    expect(verdictOf(['R-renamed', 'R-certutil'], classes, true)).toBe('ENC');
    expect(verdictOf(['R-node'], classes, true)).toBe('PLAIN');
    expect(verdictOf(['R-node', 'R-renamed'], classes, true)).toBe('MIX');
    expect(verdictOf(['R-bash'], { 'R-bash': 'other' }, true)).toBe('OTHER');
    expect(verdictOf(['R-bash'], { 'R-bash': 'error' }, true)).toBe('ERR');
    expect(verdictOf([], classes, true)).toBe('NOOBS');
    expect(verdictOf(['R-renamed'], classes, false)).toBe('FAIL');
  });
});

/** Records for a two-type run: txt has an observer (R-renamed), md has none. */
function syntheticRecords({ confirmed = true } = {}) {
  const items = planItems(MARKER).filter((item) => item.key === 'txt' || item.key === 'md');
  const read = (phase, target, reader, hexByKey, at) => ({
    type: 'read',
    reader,
    phase,
    target,
    at,
    results: items.map((item) => ({ key: item.key, exists: true, hex: hexByKey[item.key] })),
  });
  const plain = { txt: hexOf(`${MARKER} txt`), md: hexOf(`${MARKER} md`) };
  const inputRenamed = { txt: TSD_HEX, md: hexOf(`${MARKER} md`) };
  return [
    {
      type: 'meta',
      mode: 'field',
      os: 'Windows 11',
      isAdmin: true,
      enableLua: 0,
      nodeVersion: 'v24.18.0',
    },
    { type: 'plan', marker: MARKER, items, readers: READERS, writers: WRITERS },
    { type: 'reader', id: 'R-node', available: true },
    { type: 'reader', id: 'R-renamed', available: true },
    { type: 'reader', id: 'R-electron', available: false, skipReason: 'not found' },
    { type: 'writer', id: 'W-ps51', available: false, skipReason: 'test' },
    {
      type: 'manual',
      requested: true,
      confirmed,
      confirmedAt: confirmed ? '2026-09-28T01:00:00Z' : null,
    },
    read('input', 'in', 'R-node', plain, '2026-09-28T01:00:01Z'),
    read('input', 'in', 'R-renamed', inputRenamed, '2026-09-28T01:00:02Z'),
    {
      type: 'write',
      writer: 'W-node-create',
      outDir: 'C:\\enc\\out-W-node-create',
      startedAt: '2026-09-28T01:01:00Z',
      finishedAt: '2026-09-28T01:01:01Z',
      results: items.map((item) => ({ key: item.key, ok: true, error: null, detail: null })),
    },
    read('immediate', 'W-node-create', 'R-node', plain, '2026-09-28T01:01:02Z'),
    read('immediate', 'W-node-create', 'R-renamed', plain, '2026-09-28T01:01:03Z'),
    read('delayed', 'W-node-create', 'R-node', plain, '2026-09-28T01:02:01Z'),
    read(
      'delayed',
      'W-node-create',
      'R-renamed',
      { txt: TSD_HEX, md: plain.md },
      '2026-09-28T01:02:02Z'
    ),
    {
      type: 'write',
      writer: 'W-node-copy',
      outDir: 'C:\\enc\\out-W-node-copy',
      startedAt: '2026-09-28T01:01:10Z',
      finishedAt: '2026-09-28T01:01:11Z',
      results: items.map((item) => ({
        key: item.key,
        ok: item.key !== 'txt',
        error: item.key === 'txt' ? 'EPERM: x' : null,
      })),
    },
    { type: 'cleanup', renamedExe: '已删除', tempRoot: '已删除', work: '已保留' },
  ];
}

describe('buildMatrix', () => {
  it('derives effective observers from confirmed inputs and judges outputs by them', () => {
    const matrix = buildMatrix(syntheticRecords());
    expect(matrix.inputMatrix.txt).toMatchObject({
      'R-node': 'plaintext',
      'R-renamed': 'ciphertext',
      'R-ps51': 'skipped',
    });
    expect(matrix.observers).toEqual({ txt: ['R-renamed'], md: [] });
    const create = matrix.writers.find((writer) => writer.id === 'W-node-create');
    expect(create.cells.txt.immediate.verdict).toBe('PLAIN');
    expect(create.cells.txt.delayed.verdict).toBe('ENC');
    expect(create.cells.md.immediate.verdict).toBe('NOOBS');
    expect(create.phases.immediate).toMatchObject({ ran: true, ageMin: 1, ageMax: 2 });
    expect(matrix.facts.writers['W-node-create'].changed).toEqual([
      { key: 'txt', from: 'PLAIN', to: 'ENC' },
    ]);
    const copy = matrix.writers.find((writer) => writer.id === 'W-node-copy');
    expect(copy.cells.txt.immediate.verdict).toBe('-');
    expect(copy.cells.txt.write).toMatchObject({ ok: false, error: 'EPERM: x' });
    expect(matrix.facts.writers['W-node-copy'].failures).toEqual([
      { key: 'txt', error: 'EPERM: x' },
    ]);
    const ps = matrix.writers.find((writer) => writer.id === 'W-ps51');
    expect(ps).toMatchObject({ ran: false, available: false, skipReason: 'test' });
    expect(matrix.facts.pairs.find((pair) => pair.b === 'R-renamed')).toMatchObject({
      compared: true,
      same: 1,
      differ: [{ key: 'txt', a: 'plaintext', b: 'ciphertext' }],
    });
    expect(matrix.facts.pairs.find((pair) => pair.b === 'R-electron')?.compared).toBe(false);
  });

  it('counts no effective observer without manual confirmation', () => {
    const matrix = buildMatrix(syntheticRecords({ confirmed: false }));
    expect(matrix.observers).toEqual({ txt: [], md: [] });
    expect(matrix.cipherReaders.txt).toEqual(['R-renamed']);
    const create = matrix.writers.find((writer) => writer.id === 'W-node-create');
    expect(create.cells.txt.delayed.verdict).toBe('NOOBS');
    const summary = renderSummary(matrix);
    expect(summary).toContain('输入没有经过人工确认');
    expect(summary).toContain('本轮没有任何读者对人工确认已加密的输入读到 TSD 头');
  });

  it('renders the summary sections with facts only', () => {
    const summary = renderSummary(buildMatrix(syntheticRecords()));
    for (const text of [
      '管理员：是；EnableLUA=0',
      '== 输入矩阵',
      '== 有效观察者',
      'txt                    R-renamed',
      '没有有效观察者（只能靠人工确认）：md',
      '== 输出矩阵',
      '立即与延迟不同：txt（P→C）',
      'R-node 与 R-renamed：2 个类型中 1 个结果相同；不同：txt（R-node=P，R-renamed=C）',
      'W-node-copy txt：EPERM: x',
      '== 需要人工确认',
      'C:\\enc\\out-W-node-create',
      '== 明细',
    ]) {
      expect(summary).toContain(text);
    }
  });

  it('parses JSONL with a BOM and keeps bad lines as parse errors', () => {
    const { records, parseErrors } = parseRecords(
      '\uFEFF{"type":"meta"}\r\n\r\nnot json\n{"type":"note"}\n'
    );
    expect(records).toEqual([{ type: 'meta' }, { type: 'note' }]);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0].line).toBe(3);
  });

  it('accepts records shaped by Windows PowerShell 5.1 (wrapped arrays, certutil dumps)', () => {
    const items = planItems(MARKER).filter((item) => item.key === 'txt');
    const dump = '  0000  25 54 53 44 2d 48 65 61  64 65 72 2d 23 23 23 25   %TSD-Header-###%\r\n';
    const records = [
      { type: 'plan', marker: MARKER, items, readers: READERS, writers: WRITERS },
      { type: 'manual', requested: true, confirmed: true, confirmedAt: '2026-09-28T01:00:00Z' },
      {
        type: 'read',
        reader: 'R-certutil',
        phase: 'input',
        target: 'in',
        results: {
          value: [{ key: 'txt', exists: true, certutilDump: dump, exitCode: 0 }],
          Count: 1,
        },
      },
      {
        type: 'read',
        reader: 'R-bash',
        phase: 'input',
        target: 'in',
        results: [{ key: 'txt', exists: null, hex: null, error: 'no output from bash: exit 127' }],
      },
      {
        type: 'write',
        writer: 'W-ps51',
        finishedAt: '2026-09-28T01:01:00Z',
        results: { value: [{ key: 'txt', ok: true }], Count: 1 },
      },
      {
        type: 'read',
        reader: 'R-certutil',
        phase: 'immediate',
        target: 'W-ps51',
        at: '2026-09-28T01:01:05Z',
        results: [{ key: 'txt', exists: true, certutilDump: dump }],
      },
    ];
    const matrix = buildMatrix(records);
    expect(matrix.inputMatrix.txt['R-certutil']).toBe('ciphertext');
    expect(matrix.inputMatrix.txt['R-bash']).toBe('error');
    expect(matrix.observers.txt).toEqual(['R-certutil']);
    const ps = matrix.writers.find((writer) => writer.id === 'W-ps51');
    expect(ps.cells.txt.write.ok).toBe(true);
    expect(ps.cells.txt.immediate.verdict).toBe('ENC');
    expect(ps.phases.immediate.ageMin).toBe(5);
  });

  it('escapes non-ASCII in replies', () => {
    expect(asciiJson({ path: 'C:\\用户\\a.txt' })).toBe('{"path":"C:\\\\\\u7528\\u6237\\\\a.txt"}');
    expect(JSON.parse(asciiJson({ path: '用户' })).path).toBe('用户');
  });
});

describe('writeOne', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p113b-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const plainSource = () => {
    const source = join(dir, 'source.txt');
    writeFileSync(source, `${MARKER} txt plaintext line\r\n`);
    return source;
  };

  it('creates new files directly, through a hard link and through a rename, leaving no staging dir', () => {
    for (const mode of ['create', 'dsh-create', 'rename']) {
      const target = join(dir, `${mode}.txt`);
      const detail = writeOne(mode, target, undefined, `${MARKER} ${mode}\r\n`, 'W-test');
      expect(readFileSync(target, 'utf8')).toBe(`${MARKER} ${mode}\r\n`);
      if (mode !== 'create')
        expect(detail.published).toBe(mode === 'rename' ? 'rename' : 'hardlink');
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmpdir'))).toEqual([]);
    expect(() => writeOne('create', join(dir, 'create.txt'), undefined, 'x', 'W-test')).toThrow();
  });

  it('copies, copies then overwrites, and edits a copy in place', () => {
    const source = plainSource();
    writeOne('copy-only', join(dir, 'copy.txt'), source, 'unused', 'W-test');
    expect(readFileSync(join(dir, 'copy.txt'), 'utf8')).toBe(readFileSync(source, 'utf8'));
    writeOne('copy-then-write', join(dir, 'copyw.txt'), source, 'new content\r\n', 'W-test');
    expect(readFileSync(join(dir, 'copyw.txt'), 'utf8')).toBe('new content\r\n');
    const edited = writeOne('edit-existing', join(dir, 'edit.txt'), source, 'unused', 'W-edit');
    expect(edited.editApplied).toBe(true);
    expect(readFileSync(join(dir, 'edit.txt'), 'utf8')).toBe(`${MARKER} txt edited by W-edit\r\n`);
  });

  it('leaves a copy untouched when the edit needle is not readable', () => {
    const source = join(dir, 'cipher.txt');
    writeFileSync(source, Buffer.from(`${TSD_MAGIC}\u0000\u0001`, 'latin1'));
    const detail = writeOne('edit-existing', join(dir, 'edit.txt'), source, 'unused', 'W-edit');
    expect(detail.editApplied).toBe(false);
    expect(readFileSync(join(dir, 'edit.txt'))).toEqual(readFileSync(source));
    expect(existsSync(join(dir, 'edit.txt'))).toBe(true);
  });
});
