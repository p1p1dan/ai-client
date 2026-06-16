#!/usr/bin/env node
/**
 * Prepare vflow offline-fallback resources for electron-builder.
 *
 * Modes:
 *   default                          npm pack @p1p1dan/vflow from GitHub Packages, then unpack templates
 *   --from-sibling <path>            legacy: pack from a sibling vflow repo (back-compat with old sync flow)
 *   --registry <url>                 override the registry (default: https://npm.pkg.github.com)
 *
 * Outputs:
 *   resources/vflow-pkg/<name>-<version>.tgz                              consumed by AgentInstaller fallback
 *   resources/vflow/{cli.mjs,detect.mjs,template_vflow/,template_claude/} consumed at runtime by VflowService
 *
 * Exit codes:
 *   0  success
 *   1  any failure (npm pack failed, tgz missing/empty, tar extraction failed, etc.)
 *
 * Public functions exported for unit tests:
 *   parseArgs(argv)                  parse CLI arguments into a normalized options object
 *   findTgz(dir)                     return path of newest *.tgz in dir, or null
 *   extractTemplateFromTgz(tgz, dst) extract package/src/vflow/{...} into dst with prefix stripped
 *   prepare(args, projectRoot)       full pipeline orchestrator (used by main + integration tests)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const PKG_NAME = '@p1p1dan/vflow';
const DEFAULT_REGISTRY = 'https://npm.pkg.github.com';

const TEMPLATE_ENTRIES = [
    'package/src/vflow/cli.mjs',
    'package/src/vflow/detect.mjs',
    'package/src/vflow/template_vflow',
    'package/src/vflow/template_claude',
];

export function parseArgs(argv) {
    const args = { mode: 'npm', siblingPath: null, registry: DEFAULT_REGISTRY, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--from-sibling') {
            args.mode = 'sibling';
            args.siblingPath = argv[i + 1];
            i += 1;
            if (!args.siblingPath) {
                throw new Error('--from-sibling requires a path argument');
            }
        } else if (a === '--registry') {
            args.registry = argv[i + 1];
            i += 1;
            if (!args.registry) {
                throw new Error('--registry requires a url argument');
            }
        } else if (a === '--help' || a === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${a}`);
        }
    }
    return args;
}

export function findTgz(dir) {
    if (!fs.existsSync(dir)) {
        return null;
    }
    const tgzNames = fs.readdirSync(dir).filter((name) => name.endsWith('.tgz'));
    if (tgzNames.length === 0) {
        return null;
    }
    // Sort by mtime descending so the newest pack wins when multiple exist
    // (e.g. a partial leftover next to a fresh one). The single-tgz invariant
    // after ensureCleanDir + one pack still holds; this just stops a future
    // multi-pack workflow from silently picking 0.10.0 < 0.2.0 lexically.
    const withStats = tgzNames.map((name) => ({
        name,
        mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }));
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return path.join(dir, withStats[0].name);
}

function ensureCleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

export function extractTemplateFromTgz(tgzPath, destVflowDir) {
    if (!fs.existsSync(tgzPath)) {
        throw new Error(`tgz not found: ${tgzPath}`);
    }
    const destAbs = path.resolve(destVflowDir);
    ensureCleanDir(destAbs);
    // GNU tar on Windows parses any -f argument with a colon as host:path
    // (SSH-style), so an absolute "D:/foo.tgz" tries to ssh to host "D".
    // bsdtar lacks --force-local and the two tar binaries disagree on every
    // workaround. Sidestep both: copy the tgz into the destination dir,
    // run tar with cwd=destDir and a bare filename so no path component
    // contains a drive-letter colon. The staging file deliberately does NOT
    // use a .tgz extension so a crash between copy and unlink cannot poison
    // resources/vflow-pkg/ globbing (assert only looks for *.tgz there).
    const stagedArchive = path.join(destAbs, '__inprogress.tar.gz.staged');
    fs.copyFileSync(tgzPath, stagedArchive);
    try {
        const result = spawnSync(
            'tar',
            ['-xzf', '__inprogress.tar.gz.staged', '--strip-components=3', ...TEMPLATE_ENTRIES],
            { cwd: destAbs, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', shell: false }
        );
        if (result.status !== 0) {
            const stderr = (result.stderr || '').trim();
            const stdout = (result.stdout || '').trim();
            const detail = stderr || stdout || '<no output>';
            throw new Error(
                `tar extraction failed (exit ${result.status ?? 'null'}) for ${tgzPath}: ${detail}`
            );
        }
    } finally {
        if (fs.existsSync(stagedArchive)) {
            fs.unlinkSync(stagedArchive);
        }
    }
}

function runNpmPack(args, cwd, pkgDir) {
    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        shell: isWindows,
    });
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        const stdout = (result.stdout || '').trim();
        const detail = stderr || stdout || '<no output>';
        throw new Error(`npm pack failed (exit ${result.status ?? 'null'}): ${detail}`);
    }
    return (result.stdout || '').trim();
}

function packFromRegistry(pkgDir, registry, projectRoot) {
    runNpmPack(
        ['pack', PKG_NAME, `--registry=${registry}`, '--pack-destination', pkgDir],
        projectRoot,
        pkgDir
    );
}

function packFromSibling(siblingRepo, pkgDir) {
    if (!fs.existsSync(siblingRepo) || !fs.existsSync(path.join(siblingRepo, 'package.json'))) {
        throw new Error(`sibling vflow repo not found or invalid (missing package.json): ${siblingRepo}`);
    }
    runNpmPack(['pack', '--pack-destination', pkgDir], siblingRepo, pkgDir);
}

export function prepare(args, projectRoot = DEFAULT_PROJECT_ROOT) {
    const pkgDir = path.join(projectRoot, 'resources', 'vflow-pkg');
    const vflowDir = path.join(projectRoot, 'resources', 'vflow');

    ensureCleanDir(pkgDir);

    if (args.mode === 'npm') {
        packFromRegistry(pkgDir, args.registry, projectRoot);
    } else if (args.mode === 'sibling') {
        packFromSibling(args.siblingPath, pkgDir);
    } else {
        throw new Error(`Unknown mode: ${args.mode}`);
    }

    const tgz = findTgz(pkgDir);
    if (!tgz) {
        throw new Error(
            `npm pack succeeded but no .tgz was produced in ${pkgDir} (registry=${args.registry})`
        );
    }
    const size = fs.statSync(tgz).size;
    if (size <= 0) {
        throw new Error(`packed tgz is empty (0 bytes): ${tgz}`);
    }
    console.log(`[prepare-vflow] Packed ${path.basename(tgz)} (${size} bytes) -> ${pkgDir}`);

    extractTemplateFromTgz(tgz, vflowDir);
    console.log(`[prepare-vflow] Extracted vflow templates -> ${vflowDir}`);

    return { tgzPath: tgz, vflowDir };
}

function printHelp() {
    console.log(`Usage:
  node scripts/prepare-vflow-resources.mjs                       # default: npm pack from GitHub Packages
  node scripts/prepare-vflow-resources.mjs --from-sibling <path> # legacy: pack from a sibling vflow repo
  node scripts/prepare-vflow-resources.mjs --registry <url>      # override the registry`);
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
    try {
        const parsed = parseArgs(process.argv.slice(2));
        if (parsed.help) {
            printHelp();
            process.exit(0);
        }
        prepare(parsed);
    } catch (err) {
        console.error(`[prepare-vflow] ${err.message}`);
        process.exit(1);
    }
}
