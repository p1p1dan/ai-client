/**
 * H/21 C6 — read this machine's real Claude Code / Codex history through the
 * production readers and report what comes out.
 *
 * Offline on purpose: no Electron, no worker, no writes. It answers the half of
 * the acceptance list that is about READING (are the conversations found, is
 * the title a real user message, is the injected noise gone), so the expensive
 * live check only has to cover writing and continuing.
 *
 * Run: `node scripts/run-h21-import-scan-probe.mjs`
 */

import { homedir } from 'node:os';
import {
  ClaudeSessionScanner,
  resolveLegacyClaudeSessionRoot,
} from '../../src/main/services/legacyImport/ClaudeSessionScanner.ts';
import {
  claudeSourceImporter,
  codexSourceImporter,
  type LegacySourceImporter,
  scanAllLegacySources,
} from '../../src/main/services/legacyImport/LegacyImportSources.ts';

const SYNTHETIC_MARKERS = [
  '<local-command-caveat>',
  '<system-reminder>',
  '<command-name>',
  '# AGENTS.md',
  'You are Codex',
];

interface SessionReport {
  sourceKind: string;
  projectPath: string;
  sessionId: string;
  title: string;
  entries: Record<string, number>;
  syntheticLeaks: string[];
  diagnostics: number;
}

async function reportOne(
  importer: LegacySourceImporter,
  projectId: string,
  projectPath: string,
  sessionId: string
): Promise<SessionReport> {
  const read = await importer.convert({
    sourceKind: importer.source,
    projectId,
    sourceSessionId: sessionId,
  });
  const entries: Record<string, number> = {};
  const leaks: string[] = [];
  for (const entry of read.conversation.entries) {
    entries[entry.kind] = (entries[entry.kind] ?? 0) + 1;
    if (entry.kind !== 'user') continue;
    for (const marker of SYNTHETIC_MARKERS) {
      if (entry.text.includes(marker) && !leaks.includes(marker)) leaks.push(marker);
    }
  }
  return {
    sourceKind: importer.source,
    projectPath,
    sessionId,
    title: read.conversation.title.slice(0, 80),
    entries,
    syntheticLeaks: leaks,
    diagnostics: read.conversation.diagnostics.length,
  };
}

async function main(): Promise<void> {
  const claudeRoot = resolveLegacyClaudeSessionRoot();
  const importers: LegacySourceImporter[] = [
    claudeSourceImporter(new ClaudeSessionScanner({ resolveRoots: () => [claudeRoot] })),
    codexSourceImporter(),
  ];
  const projects = await scanAllLegacySources(importers);
  const reports: SessionReport[] = [];
  for (const project of projects) {
    const importer = importers.find(
      (item) => item.source === (project.sourceKind ?? 'claude-code')
    );
    if (!importer) continue;
    const { sessions } = await importer.scan(project.id);
    // A small sample per project characterises the reader without turning this
    // into a full conversion pass — the dev box is low on memory.
    const newest = [...sessions]
      .sort(
        (left, right) =>
          (right.lastMessageAt ?? right.createdAt) - (left.lastMessageAt ?? left.createdAt)
      )
      .slice(0, Number(process.env.H21_SAMPLE ?? 3));
    for (const session of newest) {
      try {
        reports.push(await reportOne(importer, project.id, project.path, session.id));
      } catch (error) {
        reports.push({
          sourceKind: importer.source,
          projectPath: project.path,
          sessionId: session.id,
          title: `<unreadable: ${error instanceof Error ? error.message : String(error)}>`,
          entries: {},
          syntheticLeaks: [],
          diagnostics: 0,
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        home: homedir(),
        claudeRoot,
        projects: projects.map((project) => ({
          sourceKind: project.sourceKind,
          path: project.path,
          sessionCount: project.sessionCount,
        })),
        reports,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
