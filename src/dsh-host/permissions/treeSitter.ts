/**
 * The bash grammar for the permission row (dsh-rebase design shard 03 §1).
 *
 * The host package carries `web-tree-sitter` and `tree-sitter-bash` (both MIT);
 * only their wasm is used. Loaded on the first bash call, once per process,
 * and handed to the pure library's walker, which never imports the package.
 * `web-tree-sitter` is imported lazily so loading the row costs nothing until
 * a shell call needs it.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { BashParser } from '../../shared/permissions/bashWalker.ts';

const require = createRequire(import.meta.url);

/** Where the two wasm files resolve from this module (the host's node_modules). */
export function treeSitterWasmPaths(): { runtime: string; grammar: string } {
  return {
    runtime: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    grammar: require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'),
  };
}

let shared: Promise<BashParser> | undefined;

/** The process-wide bash parser; a failed load is retried on the next call. */
export function loadBashParser(): Promise<BashParser> {
  shared ??= (async () => {
    const { Parser, Language } = await import('web-tree-sitter');
    const paths = treeSitterWasmPaths();
    await Parser.init({ wasmBinary: await readFile(paths.runtime) });
    const language = await Language.load(await readFile(paths.grammar));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser as BashParser;
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
