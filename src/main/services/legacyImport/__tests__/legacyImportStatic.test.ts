import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('legacy import static boundaries', () => {
  it('keeps source adapters isolated from execution runtime, launchers, and connections', () => {
    for (const relative of [
      'src/main/services/legacyImport/ClaudeSessionScanner.ts',
      'src/main/services/legacyImport/ClaudeSourceAdapter.ts',
    ]) {
      const text = source(relative);
      for (const forbidden of [
        'claudeRuntime',
        'codexRuntime',
        'codexConnection',
        'codexNodeEntry',
        'cometix',
        'child_process',
        'utilityProcess',
      ]) {
        expect(text, `${relative} -> ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('exposes import channels without a Claude resume channel', () => {
    const ipc = source('src/shared/types/ipc.ts');
    const preload = source('src/preload/index.ts');
    expect(ipc).toContain('LEGACY_IMPORT_BATCH');
    expect(ipc).not.toContain('CLAUDE_SESSIONS_');
    expect(preload).toContain('legacyImport:');
    expect(preload).not.toContain('claudeSessions:');
  });
});
