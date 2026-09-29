import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-13c static guards on the DSH seam the `aiclient-encrypted-read`
 * row wraps (decision 091). The row patches method slots on the fs service
 * instance, so an upgrade of `@deepseek-ai/*` that renames a read method,
 * moves a call site off `ctx.fs`, or re-homes the `fs` service fails here
 * before it can silently disable the fallback.
 */

const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSH = (...parts: string[]) =>
  readFileSync(join(HOST_DIR, 'node_modules', '@deepseek-ai', ...parts), 'utf8');

describe('the fs service the row wraps is the one dsh-base composes (P1-13c)', () => {
  it("dsh-base's composition carries the fs-sandbox row pointing at dsh-fs-sandbox", () => {
    const patch = DSH('dsh-base', 'cordis.patch.yml');
    expect(patch).toMatch(/- id: fs-sandbox\n\s+name: '@deepseek-ai\/dsh-fs-sandbox'/);
  });

  it('dsh-fs registers its provider under the service name "fs", as a Cordis Service', () => {
    const fs = DSH('dsh-fs', 'lib', 'index.js');
    expect(fs).toMatch(/var FileSystem = class extends Service/);
    expect(fs).toContain('super(ctx, "fs")');
  });
});

describe('the five wrapped entrances keep their names and signatures (P1-13c)', () => {
  const local = () => DSH('dsh-fs-local', 'lib', 'index.js');

  it('LocalFileSystem declares the four reads and the edit with these exact parameters', () => {
    const source = local();
    expect(source).toContain('async readText(target, signal) {');
    expect(source).toContain('streamText(target, signal) {');
    expect(source).toContain('async readBytes(target, signal, maxBytes) {');
    expect(source).toContain('async readByteRange(target, range, signal) {');
    expect(source).toContain('async editText(target, edit, expected, signal) {');
  });

  it('the reads delegate to whole-file helpers that reject binaries, enforce caps and window', () => {
    const source = local();
    // The semantics the fallback restates on decrypted plaintext (decision 091).
    expect(source).toContain('readWholeText({');
    expect(source).toContain('streamWholeText({');
    expect(source).toContain('readWholeBytes({');
    expect(source).toContain('readByteWindow({');
    expect(source).toMatch(/cannot read "\$\{target\.displayPath\}": binary file/);
    expect(source).toMatch(
      /cannot read "\$\{target\.displayPath\}": \$\{info\.size\} bytes exceeds the \$\{maxBytes\}-byte limit/
    );
  });

  it('SandboxedFileSystem only fences the two mutations, so the reads stay inherited', () => {
    const sandbox = DSH('dsh-fs-sandbox', 'lib', 'index.js');
    expect(sandbox).toContain('var SandboxedFileSystem = class extends LocalFileSystem');
    expect(sandbox).toMatch(/async writeText\(target, content, expected, signal, sandboxPolicy\)/);
    expect(sandbox).toMatch(/async editText\(target, edit, expected, signal, sandboxPolicy\)/);
    // The wrapper passes a fifth argument through to the sandbox fence.
    expect(sandbox).toContain('super.editText(await this.checkedTarget(target, sandboxPolicy)');
  });
});

describe('the model-facing readers all call the wrapped entrances through ctx.fs (P1-13c)', () => {
  it('dsh-tool-fs read chooses streamText or readText by size, and both stay on ctx.fs', () => {
    const tool = DSH('dsh-tool-fs', 'lib', 'index.js');
    expect(tool).toContain('ctx.fs.streamText(target, exec.signal)');
    expect(tool).toContain('ctx.fs.readText(target, exec.signal)');
  });

  it('dsh-tool-fs read_image reads its bytes with ctx.fs.readBytes under a cap', () => {
    const tool = DSH('dsh-tool-fs', 'lib', 'index.js');
    expect(tool).toContain('ctx.fs.readBytes(target, exec.signal, byteCap)');
  });

  it('dsh-tool-fs edit goes through ctx.fs.editText with the per-call sandbox policy', () => {
    const tool = DSH('dsh-tool-fs', 'lib', 'index.js');
    expect(tool).toContain('await ctx.fs.editText(target, {');
    expect(tool).toContain('}, intent, exec.signal, sandboxPolicy)');
  });

  it('the skill provider and the instructions reader stream and read text through the service', () => {
    expect(DSH('dsh-skill-filesystem', 'lib', 'index.js')).toContain(
      'await fs.readText(target, signal)'
    );
    expect(DSH('dsh-agent-instructions', 'lib', 'index.js')).toContain(
      'fileSystem.streamText(file.target, signal)'
    );
  });
});
