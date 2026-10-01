import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

const repoRoot = path.resolve(__dirname, '../../../../..');

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/** The code of a file, comments blanked: its doc comments name what it may not use. */
function code(relative: string): string {
  return stripComments(source(relative), relative);
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('legacy import static boundaries', () => {
  it('keeps source adapters isolated from execution runtime, launchers, and connections', () => {
    for (const relative of [
      'src/main/services/legacyImport/ClaudeSessionScanner.ts',
      'src/main/services/legacyImport/ClaudeSourceAdapter.ts',
      'src/main/services/legacyImport/CodexSessionScanner.ts',
      'src/main/services/legacyImport/CodexSourceAdapter.ts',
      'src/main/services/legacyImport/CodexRollout.ts',
      'src/main/services/legacyImport/LegacyImportSources.ts',
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

  /**
   * dsh-rebase P1-9f (decision 056): a Claude Code / Codex import becomes a
   * DSH chat through the shared host, and nothing on the import path can make
   * a pi row or reach the pi import worker again. The index enforces the same
   * at run time (`createImported` refuses a non-DSH import row).
   */
  it('imports make DSH chats only: no pi row, no pi import worker (P1-9f)', () => {
    const service = code('src/main/services/legacyImport/LegacyImportService.ts');
    const engine = code('src/main/services/legacyImport/DshLegacyImportHost.ts');
    for (const [name, text] of [
      ['LegacyImportService', service],
      ['DshLegacyImportHost', engine],
    ] as const) {
      for (const banned of [
        'PI_AGENT',
        "agent: 'pi'",
        'piLeaf',
        'PiImportProcess',
        'createPiImport',
        'inspectPiImport',
        'reconcilePiImport',
        'forkPiWorkerProcess',
        'PiWorkerProcess',
        'WorkerManager',
        'workerManager',
        'createLegacyImport',
        'inspectLegacyImport',
        'reconcileLegacyImport',
        'worker.import',
        'finalSessionFile',
      ]) {
        expect(text, `${name} -> ${banned}`).not.toContain(banned);
      }
    }
    // The one row the service writes is a DSH row naming the host's stub.
    expect(service.match(/agent: DSH_AGENT/g)).toHaveLength(1);
    expect(service).toContain('runtimeIdentity: imported.sessionFile');
    expect(service).toContain('dshImportTargetId(logicalSessionId)');
    expect(service).toContain('new DshLegacyImportHost()');
    expect(engine).toContain('seedImportedConversation(');
    const index = code('src/main/services/chat/SessionIndexService.ts');
    expect(index).toContain('input.legacyImport && input.agent !== DSH_AGENT');
  });

  /**
   * P1-12 step 1 (decisions 124 rule 19 and 147) deleted the pi import worker
   * and WorkerManager's three import methods. Nothing in Main may name them
   * again: a caller would bring pi imports back.
   */
  it('has no pi import worker and no caller of one (P1-12)', () => {
    const main = path.join(repoRoot, 'src', 'main');
    const names = [
      'PiImportProcess',
      'createLegacyImport',
      'inspectLegacyImport',
      'reconcileLegacyImport',
    ];
    const naming = tsFiles(main)
      .filter((file) => file !== __filename)
      .filter((file) => {
        const text = stripComments(readFileSync(file, 'utf8'), file);
        return names.some((name) => text.includes(name));
      })
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .sort();
    expect(naming).toEqual([]);
    expect(existsSync(path.join(main, 'services', 'legacyImport', 'PiImportProcess.ts'))).toBe(
      false
    );
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
