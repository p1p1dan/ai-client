import type {
  ImportedConversation,
  LegacyImportProject,
  LegacyImportSessionPreview,
  LegacyImportSourceKind,
  LegacyImportSourceRef,
} from '@shared/types';
import type { ClaudeSessionScanner } from './ClaudeSessionScanner';
import { ClaudeSourceAdapter } from './ClaudeSourceAdapter';
import { CodexSessionScanner } from './CodexSessionScanner';
import { CodexSourceAdapter } from './CodexSourceAdapter';

export interface ConvertedLegacySource {
  conversation: ImportedConversation;
  sourcePath: string;
  assertUnchanged(): Promise<void>;
}

export interface LegacySourceImporter {
  source: LegacyImportSourceKind;
  scan(
    projectId?: string
  ): Promise<{ projects: LegacyImportProject[]; sessions: LegacyImportSessionPreview[] }>;
  convert(source: LegacyImportSourceRef): Promise<ConvertedLegacySource>;
}

function conversion(adapter: ClaudeSourceAdapter | CodexSourceAdapter) {
  return async (source: LegacyImportSourceRef): Promise<ConvertedLegacySource> => {
    const read = await adapter.read(source);
    return {
      ...read,
      assertUnchanged: () =>
        adapter.assertUnchanged(read.sourcePath, read.conversation.sourceFingerprint),
    };
  };
}

export function claudeSourceImporter(scanner: ClaudeSessionScanner): LegacySourceImporter {
  return {
    source: 'claude-code',
    scan: async (projectId) =>
      projectId
        ? { projects: [], sessions: await scanner.getSessionsForProject(projectId) }
        : { projects: await scanner.scanProjects(), sessions: [] },
    convert: conversion(new ClaudeSourceAdapter(scanner)),
  };
}

export function codexSourceImporter(scanner = new CodexSessionScanner()): LegacySourceImporter {
  return {
    source: 'codex',
    async scan(projectId) {
      const summaries = await scanner.scan();
      const projects = new Map<string, LegacyImportProject>();
      for (const summary of summaries) {
        const project = projects.get(summary.projectId) ?? {
          id: summary.projectId,
          path: summary.workspacePath,
          sessionCount: 0,
          lastActivityAt: 0,
        };
        project.sessionCount++;
        project.lastActivityAt = Math.max(
          project.lastActivityAt,
          Math.floor((summary.endedAt ?? summary.startedAt ?? 0) / 1000)
        );
        projects.set(project.id, project);
      }
      return {
        projects: [...projects.values()],
        sessions: summaries
          .filter((summary) => summary.projectId === projectId)
          .map((summary) => ({
            id: summary.sessionId,
            projectId: summary.projectId,
            firstMessage: summary.firstMessage,
            createdAt: Math.floor((summary.startedAt ?? 0) / 1000),
            lastMessageAt:
              summary.endedAt === undefined ? null : Math.floor(summary.endedAt / 1000),
            model: summary.model ?? null,
            importedSnapshots: 0,
          })),
      };
    },
    convert: conversion(new CodexSourceAdapter(scanner)),
  };
}

export async function scanAllLegacySources(
  importers: readonly LegacySourceImporter[]
): Promise<LegacyImportProject[]> {
  const projects: LegacyImportProject[] = [];
  // Serial scans keep peak memory bounded on the supported low-memory hosts.
  for (const importer of importers) {
    try {
      const result = await importer.scan();
      projects.push(
        ...result.projects.map((project) => ({ ...project, sourceKind: importer.source }))
      );
    } catch {
      // A bad source does not hide other sources from the import picker.
    }
  }
  return projects.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}
