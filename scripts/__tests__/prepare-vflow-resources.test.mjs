import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTemplateFromTgz, findTgz, parseArgs } from '../prepare-vflow-resources.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_TGZ = path.join(__dirname, 'fixtures', 'p1p1dan-vflow-fixture.tgz');

let scratch;

beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-vflow-test-'));
});

afterEach(() => {
    if (scratch && fs.existsSync(scratch)) {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

describe('parseArgs', () => {
    it('returns npm-mode defaults with no arguments', () => {
        const args = parseArgs([]);
        expect(args.mode).toBe('npm');
        expect(args.registry).toBe('https://npm.pkg.github.com');
        expect(args.siblingPath).toBeNull();
        expect(args.help).toBe(false);
    });

    it('parses --from-sibling with a path', () => {
        const args = parseArgs(['--from-sibling', '/abs/path/to/vflow']);
        expect(args.mode).toBe('sibling');
        expect(args.siblingPath).toBe('/abs/path/to/vflow');
    });

    it('parses --registry override', () => {
        const args = parseArgs(['--registry', 'https://example.com']);
        expect(args.registry).toBe('https://example.com');
    });

    it('parses --help / -h flag', () => {
        expect(parseArgs(['--help']).help).toBe(true);
        expect(parseArgs(['-h']).help).toBe(true);
    });

    it('throws when --from-sibling has no path', () => {
        expect(() => parseArgs(['--from-sibling'])).toThrow(/requires a path/);
    });

    it('throws when --registry has no value', () => {
        expect(() => parseArgs(['--registry'])).toThrow(/requires a url/);
    });

    it('throws on unknown argument', () => {
        expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    });
});

describe('findTgz', () => {
    it('returns null for a non-existent directory', () => {
        expect(findTgz(path.join(scratch, 'nope'))).toBeNull();
    });

    it('returns null when no .tgz exists in dir', () => {
        fs.writeFileSync(path.join(scratch, 'README.md'), 'hi');
        expect(findTgz(scratch)).toBeNull();
    });

    it('returns the lexicographically last .tgz when multiple exist', () => {
        fs.writeFileSync(path.join(scratch, 'a-0.1.0.tgz'), 'x');
        fs.writeFileSync(path.join(scratch, 'b-0.2.0.tgz'), 'x');
        fs.writeFileSync(path.join(scratch, 'irrelevant.txt'), 'x');
        const found = findTgz(scratch);
        expect(found).toBe(path.join(scratch, 'b-0.2.0.tgz'));
    });
});

describe('extractTemplateFromTgz', () => {
    it('extracts the four required template entries with stripped prefix', () => {
        const dest = path.join(scratch, 'vflow');
        extractTemplateFromTgz(FIXTURE_TGZ, dest);
        expect(fs.existsSync(path.join(dest, 'cli.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'detect.mjs'))).toBe(true);
        expect(fs.statSync(path.join(dest, 'template_vflow')).isDirectory()).toBe(true);
        expect(fs.statSync(path.join(dest, 'template_claude')).isDirectory()).toBe(true);
        // sanity: package/src/vflow prefix must be stripped
        expect(fs.existsSync(path.join(dest, 'package'))).toBe(false);
    });

    it('throws a descriptive error when tgz is missing', () => {
        const missing = path.join(scratch, 'does-not-exist.tgz');
        expect(() => extractTemplateFromTgz(missing, path.join(scratch, 'vflow'))).toThrow(
            /tgz not found/
        );
    });

    it('is idempotent — re-running clears stale content in the destination', () => {
        const dest = path.join(scratch, 'vflow');
        // Pre-seed a stale file that must not survive a re-extract.
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'stale.txt'), 'old');
        extractTemplateFromTgz(FIXTURE_TGZ, dest);
        expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
        expect(fs.existsSync(path.join(dest, 'cli.mjs'))).toBe(true);
    });
});
