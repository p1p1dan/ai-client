#!/usr/bin/env node
/**
 * Assert that vflow offline-fallback resources are present and well-formed before
 * electron-builder runs. Zero side effects: only reads the filesystem.
 *
 * Checks (all errors accumulated, then reported in one shot — never bail on the first):
 *   1. resources/vflow-pkg/ contains at least one *.tgz with size > 0
 *   2. resources/vflow/cli.mjs           exists & non-empty
 *   3. resources/vflow/detect.mjs        exists & non-empty
 *   4. resources/vflow/template_vflow/   exists & non-empty directory
 *   5. resources/vflow/template_claude/  exists & non-empty directory
 *
 * Exit codes:
 *   0  all checks pass
 *   1  any check fails (full failure report on stderr)
 *
 * Public functions exported for unit tests:
 *   checkTgz(pkgDir)                 returns { ok, error }
 *   checkTemplate(vflowDir)          returns { ok, errors[] }
 *   assertAll(projectRoot)           returns { ok, errors[] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = ['cli.mjs', 'detect.mjs'];
const REQUIRED_DIRS = ['template_vflow', 'template_claude'];

export function checkTgz(pkgDir) {
    if (!fs.existsSync(pkgDir)) {
        return { ok: false, error: `vflow-pkg directory missing: ${pkgDir}` };
    }
    let entries;
    try {
        entries = fs.readdirSync(pkgDir);
    } catch (err) {
        return { ok: false, error: `failed to read vflow-pkg directory ${pkgDir}: ${err.message}` };
    }
    const tgzEntries = entries.filter((name) => name.endsWith('.tgz'));
    if (tgzEntries.length === 0) {
        return { ok: false, error: `no *.tgz found in ${pkgDir} (expected the @p1p1dan/vflow offline fallback)` };
    }
    const empty = tgzEntries.filter((name) => fs.statSync(path.join(pkgDir, name)).size <= 0);
    if (empty.length > 0) {
        return {
            ok: false,
            error: `empty (0 bytes) tgz files in ${pkgDir}: ${empty.join(', ')}`,
        };
    }
    return { ok: true, error: null };
}

function isNonEmptyDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            return false;
        }
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) {
            return false;
        }
        return fs.readdirSync(dir).length > 0;
    } catch {
        // Broken symlink, permission error, etc. — treat as not-present so the
        // caller adds a clean error instead of the script crashing.
        return false;
    }
}

function isNonEmptyFile(file) {
    try {
        if (!fs.existsSync(file)) {
            return false;
        }
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

export function checkTemplate(vflowDir) {
    const errors = [];
    if (!fs.existsSync(vflowDir)) {
        errors.push(`vflow templates directory missing: ${vflowDir}`);
        return { ok: false, errors };
    }
    for (const name of REQUIRED_FILES) {
        const filePath = path.join(vflowDir, name);
        if (!isNonEmptyFile(filePath)) {
            errors.push(`required file missing or empty: ${filePath}`);
        }
    }
    for (const name of REQUIRED_DIRS) {
        const dirPath = path.join(vflowDir, name);
        if (!isNonEmptyDir(dirPath)) {
            errors.push(`required directory missing or empty: ${dirPath}`);
        }
    }
    return { ok: errors.length === 0, errors };
}

export function assertAll(projectRoot = DEFAULT_PROJECT_ROOT) {
    const pkgDir = path.join(projectRoot, 'resources', 'vflow-pkg');
    const vflowDir = path.join(projectRoot, 'resources', 'vflow');
    const errors = [];

    const tgz = checkTgz(pkgDir);
    if (!tgz.ok) {
        errors.push(tgz.error);
    }

    const tpl = checkTemplate(vflowDir);
    if (!tpl.ok) {
        errors.push(...tpl.errors);
    }

    return { ok: errors.length === 0, errors };
}

const isEntry = (() => {
    try {
        const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
        return invoked === __filename;
    } catch {
        return false;
    }
})();

if (isEntry) {
    const result = assertAll();
    if (result.ok) {
        console.log('[assert-vflow] OK — tgz fallback and templates are in place.');
        process.exit(0);
    }
    console.error('[assert-vflow] FAILED — vflow offline-fallback resources are incomplete:');
    for (const err of result.errors) {
        console.error(`  - ${err}`);
    }
    console.error('\nRun `pnpm prepare:vflow` to regenerate these resources before packaging.');
    process.exit(1);
}
