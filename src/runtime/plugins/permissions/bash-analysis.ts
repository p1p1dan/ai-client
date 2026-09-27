/**
 * The runtime's bash analyzer: a thin wrapper (dsh-rebase P1-6a).
 *
 * The AST walk lives in `src/shared/permissions/bashWalker.ts` and takes the
 * parser as an argument. What stays here is the runtime's own half: loading
 * the `web-tree-sitter` and `tree-sitter-bash` wasm through HostIo and owning
 * the parser's lifetime.
 */

import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import { analyzeBash, type BashAnalysis } from '../../../shared/permissions/bashWalker.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';

export {
  type BashAnalysis,
  normalizeShellPath,
  shellOperandPath,
  splitShellPath,
} from '../../../shared/permissions/bashWalker.ts';

const require = createRequire(import.meta.url);

let sharedLanguage: Promise<Language> | undefined;
async function loadLanguage(io: RuntimeHostIoService): Promise<Language> {
  try {
    const wasm = await io.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), {
      maxBytes: 4 * 1024 * 1024,
      overflow: 'error',
    });
    await Parser.init({ wasmBinary: wasm.bytes });
    const grammar = await io.readFile(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'), {
      maxBytes: 4 * 1024 * 1024,
      overflow: 'error',
    });
    return await Language.load(grammar.bytes);
  } catch (error) {
    sharedLanguage = undefined;
    throw error;
  }
}

// Adapt the old permission plugin's AST approach, without importing its Pi SDK
// or filesystem code. WASM assets are read through the same HostIo as tool data.
export class BashAnalyzer {
  private ready?: Promise<Parser>;
  private readonly io: RuntimeHostIoService;
  constructor(io: RuntimeHostIoService) {
    this.io = io;
  }
  private async initialize(): Promise<Parser> {
    sharedLanguage ??= loadLanguage(this.io);
    const language = await sharedLanguage;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }
  async dispose(): Promise<void> {
    if (this.ready)
      await this.ready.then(
        (parser) => parser.delete(),
        () => {}
      );
  }
  async analyze(command: string, cwd: string, env: Record<string, string>): Promise<BashAnalysis> {
    this.ready ??= this.initialize();
    const parser = await this.ready;
    return analyzeBash(
      parser,
      command,
      cwd,
      env,
      (code, message, options) => new RuntimeHostError(code, message, options)
    );
  }
}
