import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard against a build-breaking trap in electron-vite's `vite:esm-shim`.
 *
 * That plugin appends the CommonJS shim after the LAST static ESM import it
 * finds, and it locates imports with a plain regex over the whole bundled
 * chunk — string literals included. Its pattern accepts the side-effect form
 * (`import "specifier"`), so a source string that ENDS with the bare word
 * `import` right before its closing quote reads as the start of one:
 *
 *   'Recovered and cleaned an interrupted legacy import'
 *                                              ^^^^^^^^^ looks like `import '`
 *
 * The regex then runs to the next quote anywhere later in the bundle, and the
 * shim is spliced into the middle of whatever string that turns out to be. The
 * build dies with an opaque `Unterminated string literal` pointing at an
 * innocent line hundreds of statements away — it names the victim, never the
 * cause. This cost a whole `pnpm build` before anyone noticed.
 *
 * The fix is trivial (any trailing word works: `import run`, `import step`),
 * so this test just keeps the trap from being re-armed.
 */

const SCAN_ROOTS = ['main', 'shared', 'preload', 'agent-host'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Whitespace, the bare word `import`, then a quote — the shape the plugin misreads. */
const TRAP = /\simport\s*['"]/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/** A real side-effect import is a statement, not a string ending in `import`. */
function isRealImportStatement(line: string): boolean {
  return /^\s*import\s*['"]/.test(line);
}

describe('electron-vite esm-shim string trap', () => {
  it('no bundled source string ends with the bare word `import`', () => {
    const srcRoot = path.join(__dirname, '..', '..');
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(path.join(srcRoot, root))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!TRAP.test(line) || isRealImportStatement(line)) return;
          offenders.push(`${path.relative(srcRoot, file)}:${index + 1}: ${line.trim()}`);
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
