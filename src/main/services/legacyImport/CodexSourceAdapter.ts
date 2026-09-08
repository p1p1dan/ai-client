import {
  type ImportedConversation,
  LEGACY_IMPORT_SCHEMA_VERSION,
  LEGACY_IMPORTER_VERSION,
  type LegacyImportSourceFingerprint,
  type LegacyImportSourceRef,
} from '@shared/types';
import { type CodexSessionScanner, readCodexSessionSource } from './CodexSessionScanner';

export class CodexSourceAdapter {
  constructor(private readonly scanner: CodexSessionScanner) {}

  async read(
    source: LegacyImportSourceRef
  ): Promise<{ conversation: ImportedConversation; sourcePath: string }> {
    if (source.sourceKind !== 'codex') throw new Error('Unsupported Codex import source');
    const selected = await this.scanner.resolveSessionSource(
      source.projectId,
      source.sourceSessionId
    );
    const { rollout, fingerprint } = selected;
    const first = rollout.entries.find((entry) => entry.kind === 'user');
    return {
      sourcePath: selected.filePath,
      conversation: {
        schemaVersion: LEGACY_IMPORT_SCHEMA_VERSION,
        importerVersion: LEGACY_IMPORTER_VERSION,
        sourceKind: 'codex',
        stableSourceIdentity: fingerprint.stableSourceIdentity,
        sourceSessionId: rollout.sessionId,
        workspacePath: rollout.workspacePath,
        title: first?.kind === 'user' ? first.text.slice(0, 120) : 'Imported Codex session',
        model: rollout.model,
        startedAt: rollout.startedAt,
        endedAt: rollout.endedAt,
        sourceFingerprint: fingerprint,
        entries: rollout.entries,
        diagnostics: rollout.diagnostics,
      },
    };
  }

  async assertUnchanged(filePath: string, expected: LegacyImportSourceFingerprint): Promise<void> {
    const { fingerprint: current } = await readCodexSessionSource(filePath);
    if (
      current.stableSourceIdentity !== expected.stableSourceIdentity ||
      current.contentHash !== expected.contentHash ||
      current.size !== expected.size ||
      current.mode !== expected.mode ||
      current.mtimeMs !== expected.mtimeMs
    ) {
      throw new Error('Codex source changed before publish; retry the import step');
    }
  }
}
