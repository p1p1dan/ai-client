import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T036 / decision 012 — the Extension UI chain is gone, and stays gone.
 *
 * It was the pi-era pipe that let an extension open a dialog, hang a status
 * line or raise a notification inside the GUI: a worker-side bridge, three
 * runtime event types, an RPC command, an IPC channel, two renderer stores and
 * four components. P6-5 left it with no producer — GUI sessions run this app's
 * own runtime and load no pi extensions — and T025/T026 cut its last readers.
 *
 * A deletion this wide is easy to half-undo: one re-added type, one revived
 * store, and the dead branch is back with nothing behind it. So instead of
 * pinning the files that used to exist (a list that says nothing about a file
 * under a new name), this scans the shipped source for the vocabulary itself.
 */

const repoRoot = path.resolve(__dirname, '../../../../..');
const SCANNED_ROOTS = ['src', 'scripts'] as const;
const CODE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'release', '.vite']);

/** The chain's vocabulary: `extensionUi`, `ExtensionUI`, `extension_ui`, … */
const RETIRED = /extension[_-]?ui/i;

/**
 * Files allowed to name it, and why.
 *
 * This gate, because it has to spell out what it forbids; and the replay test,
 * because the only way to prove an old recording's retired event is IGNORED is
 * to feed the renderer one by name.
 */
const ALLOWED = new Set(
  [__filename, path.join(repoRoot, 'src/renderer/stores/__tests__/nativeStreamReplay.test.ts')].map(
    (file) => path.resolve(file)
  )
);

function codeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      codeFiles(full, out);
      continue;
    }
    if (CODE_FILE.test(name)) out.push(full);
  }
  return out;
}

describe('T036 Extension UI absence gate', () => {
  it('names the retired chain nowhere in the shipped source', () => {
    const offenders: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of codeFiles(path.join(repoRoot, root))) {
        if (ALLOWED.has(path.resolve(file))) continue;
        // Read as latin1, not utf8: a few generated sources carry NUL bytes,
        // and a decoder that replaces them can drop the surrounding run of
        // text — which is exactly how a grep of this repo misses a file.
        const source = readFileSync(file, 'latin1');
        if (!RETIRED.test(source)) continue;
        const line = source.split('\n').findIndex((text) => RETIRED.test(text)) + 1;
        offenders.push(`${path.relative(repoRoot, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the chain out of the IPC, RPC and event protocols by name', () => {
    const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const [relative, forbidden] of [
      ['src/shared/types/ipc.ts', 'CHAT_RESPOND_EXTENSION_UI'],
      ['src/shared/types/ipc.ts', 'chat:respondExtensionUi'],
      ['src/shared/types/workerRpc.ts', 'worker.extensionUi.respond'],
      ['src/shared/types/runtimeEvents.ts', 'extensionUi.request'],
      ['src/shared/types/runtimeEvents.ts', 'extensionUi.cancelled'],
      ['src/shared/types/runtimeEvents.ts', 'extensionUi.reset'],
      ['src/preload/index.ts', 'respondExtensionUi'],
    ] as const) {
      expect(read(relative), `${relative} -> ${forbidden}`).not.toContain(forbidden);
    }
  });
});
