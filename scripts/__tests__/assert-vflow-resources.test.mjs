import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertAll, checkTemplate, checkTgz } from '../assert-vflow-resources.mjs';

// Helper: build a minimal projectRoot layout under a scratch directory.
function buildLayout(root, { withTgz = true, tgzSize = 100, withTemplate = 'full' } = {}) {
    const pkgDir = path.join(root, 'resources', 'vflow-pkg');
    const vflowDir = path.join(root, 'resources', 'vflow');
    fs.mkdirSync(pkgDir, { recursive: true });
    if (withTgz === true) {
        const tgz = path.join(pkgDir, 'p1p1dan-vflow-0.0.0.tgz');
        fs.writeFileSync(tgz, Buffer.alloc(tgzSize, 0x42));
    }
    if (withTemplate === 'none') {
        return { pkgDir, vflowDir };
    }
    fs.mkdirSync(vflowDir, { recursive: true });
    if (withTemplate === 'empty') {
        return { pkgDir, vflowDir };
    }
    fs.writeFileSync(path.join(vflowDir, 'cli.mjs'), '// stub');
    fs.writeFileSync(path.join(vflowDir, 'detect.mjs'), '// stub');
    fs.mkdirSync(path.join(vflowDir, 'template_vflow'), { recursive: true });
    fs.writeFileSync(path.join(vflowDir, 'template_vflow', 'workflow.md'), 'stub');
    fs.mkdirSync(path.join(vflowDir, 'template_claude'), { recursive: true });
    fs.writeFileSync(path.join(vflowDir, 'template_claude', 'CLAUDE.md'), 'stub');
    if (withTemplate === 'missing-cli') {
        fs.unlinkSync(path.join(vflowDir, 'cli.mjs'));
    } else if (withTemplate === 'missing-template-vflow') {
        fs.rmSync(path.join(vflowDir, 'template_vflow'), { recursive: true, force: true });
    } else if (withTemplate === 'empty-template-claude') {
        fs.rmSync(path.join(vflowDir, 'template_claude'), { recursive: true, force: true });
        fs.mkdirSync(path.join(vflowDir, 'template_claude'));
    }
    return { pkgDir, vflowDir };
}

let scratch;

beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-vflow-test-'));
});

afterEach(() => {
    if (scratch && fs.existsSync(scratch)) {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

describe('checkTgz', () => {
    it('fails when the pkg directory does not exist', () => {
        const { ok, error } = checkTgz(path.join(scratch, 'nope'));
        expect(ok).toBe(false);
        expect(error).toMatch(/vflow-pkg directory missing/);
    });

    it('fails when the pkg directory contains no .tgz', () => {
        const pkgDir = path.join(scratch, 'pkg');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'README.md'), 'hi');
        const { ok, error } = checkTgz(pkgDir);
        expect(ok).toBe(false);
        expect(error).toMatch(/no \*\.tgz found/);
    });

    it('fails when a .tgz exists but is 0 bytes', () => {
        const pkgDir = path.join(scratch, 'pkg');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'empty.tgz'), '');
        const { ok, error } = checkTgz(pkgDir);
        expect(ok).toBe(false);
        expect(error).toMatch(/empty \(0 bytes\)/);
    });

    it('passes when a non-empty .tgz exists', () => {
        const { pkgDir } = buildLayout(scratch);
        const { ok, error } = checkTgz(pkgDir);
        expect(ok).toBe(true);
        expect(error).toBeNull();
    });
});

describe('checkTemplate', () => {
    it('fails when the templates directory does not exist', () => {
        const result = checkTemplate(path.join(scratch, 'vflow'));
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/templates directory missing/);
    });

    it('reports cli.mjs as missing when it is absent', () => {
        const { vflowDir } = buildLayout(scratch, { withTemplate: 'missing-cli' });
        const result = checkTemplate(vflowDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => /cli\.mjs/.test(e))).toBe(true);
    });

    it('reports template_vflow directory missing', () => {
        const { vflowDir } = buildLayout(scratch, { withTemplate: 'missing-template-vflow' });
        const result = checkTemplate(vflowDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => /template_vflow/.test(e))).toBe(true);
    });

    it('reports template_claude as empty when its directory exists but is empty', () => {
        const { vflowDir } = buildLayout(scratch, { withTemplate: 'empty-template-claude' });
        const result = checkTemplate(vflowDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => /template_claude/.test(e))).toBe(true);
    });

    it('passes when all four required entries are present and non-empty', () => {
        const { vflowDir } = buildLayout(scratch);
        const result = checkTemplate(vflowDir);
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
    });
});

describe('assertAll', () => {
    it('passes when both tgz and templates are valid', () => {
        buildLayout(scratch);
        const result = assertAll(scratch);
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accumulates errors from both checks without bailing early', () => {
        // empty pkg dir + missing templates -> at least 2 errors
        const pkgDir = path.join(scratch, 'resources', 'vflow-pkg');
        fs.mkdirSync(pkgDir, { recursive: true });
        const result = assertAll(scratch);
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
});
