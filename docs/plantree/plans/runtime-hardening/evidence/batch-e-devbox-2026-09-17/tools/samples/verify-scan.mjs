#!/usr/bin/env node
// T032 sample verification: run the REAL scanners/adapters against the fake
// homes in /tmp/t032/samples, without Electron and without touching the repo.
//
// The scanner modules are plain Node code (fs + crypto only), but they import
// through the '@shared' alias and are written in TypeScript, so we bundle them
// with the repo's own esbuild into a throwaway ESM file under /tmp and import
// that. No repo file is read-modify-written and no vitest run is needed.
//
//   node /tmp/t032/samples/verify-scan.mjs
//
// Writes its findings to stdout; capture with `| tee verify-scan.txt`.

import { build } from '/home/ai/code/ai-client/node_modules/esbuild/lib/main.js';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO = '/home/ai/code/ai-client';
const LI = `${REPO}/src/main/services/legacyImport`;
const SAMPLES = '/tmp/t032/samples';
const CLAUDE_HOME = join(SAMPLES, 'claude-home');
const CODEX_SESSIONS = join(SAMPLES, 'codex-home', 'sessions');
const LEGACY_SESSIONS = join(SAMPLES, 'codex-legacy-synthetic', 'sessions');
const CHMOD_TARGET = join(CODEX_SESSIONS, '2026', '09', '12');
const OUT_DIR = join(SAMPLES, '.verify-build');

const ENTRY = `
export { ClaudeSessionScanner } from '${LI}/ClaudeSessionScanner';
export { ClaudeSourceAdapter } from '${LI}/ClaudeSourceAdapter';
export { CodexSessionScanner } from '${LI}/CodexSessionScanner';
export { CodexSourceAdapter } from '${LI}/CodexSourceAdapter';
export { claudeSourceImporter, codexSourceImporter, scanAllLegacySources } from '${LI}/LegacyImportSources';
export { parseCodexRollout } from '${LI}/CodexRollout';
`;

async function loadScanners() {
  await mkdir(OUT_DIR, { recursive: true });
  const entryPath = join(OUT_DIR, 'entry.ts');
  await writeFile(entryPath, ENTRY, 'utf8');
  const outfile = join(OUT_DIR, 'bundle.mjs');
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    alias: { '@shared': `${REPO}/src/shared` },
  });
  return import(outfile);
}

function ms(start) {
  return `${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(0)} ms`;
}

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

async function main() {
  console.log(`generated at : ${new Date().toISOString()}`);
  console.log(`repo HEAD    : ${process.env.T032_HEAD ?? '(see README)'}`);
  const m = await loadScanners();

  // ---------------------------------------------------------------- Claude --
  heading('Claude scanner (CLAUDE_CONFIG_DIR = claude-home)');
  const claudeScanner = new m.ClaudeSessionScanner({
    resolveRoots: () => [{ dir: CLAUDE_HOME, kind: 'legacy' }],
  });
  let t = process.hrtime.bigint();
  const projects = await claudeScanner.scanProjects();
  console.log(`scanProjects: ${projects.length} project(s) in ${ms(t)}`);
  for (const p of projects) {
    console.log(`  id=${p.id}  path=${p.path}  sessions=${p.sessionCount}`);
  }
  for (const p of projects) {
    t = process.hrtime.bigint();
    const sessions = await claudeScanner.getSessionsForProject(p.id);
    console.log(`getSessionsForProject(${p.id}): ${sessions.length} session(s) in ${ms(t)}`);
    for (const s of sessions) {
      console.log(`  ${s.id}  model=${s.model}  title=${JSON.stringify(s.firstMessage)}`);
    }
  }

  // --------------------------------------------- Claude oversize behaviour --
  heading('Claude import of each sample (ClaudeSourceAdapter.read)');
  const adapter = new m.ClaudeSourceAdapter(claudeScanner);
  for (const p of projects) {
    const sessions = await claudeScanner.getSessionsForProject(p.id);
    for (const s of sessions) {
      t = process.hrtime.bigint();
      try {
        const read = await adapter.read({
          sourceKind: 'claude-code',
          projectId: p.id,
          sourceSessionId: s.id,
        });
        console.log(
          `  ${s.id}: OK in ${ms(t)} — entries=${read.conversation.entries.length} ` +
            `bytes=${read.conversation.sourceFingerprint.size}`
        );
      } catch (error) {
        console.log(`  ${s.id}: FAILED in ${ms(t)} — ${error?.name}: ${error?.message}`);
      }
    }
  }

  // ----------------------------------------------------------------- Codex --
  heading('Codex scanner (CODEX_HOME = codex-home), all date dirs readable');
  const codexScanner = new m.CodexSessionScanner(() => CODEX_SESSIONS);
  t = process.hrtime.bigint();
  const summaries = await codexScanner.scan();
  console.log(`scan(): ${summaries.length} session(s) in ${ms(t)}`);
  const byProject = new Map();
  for (const s of summaries) byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + 1);
  for (const [id, count] of byProject) console.log(`  project ${id}: ${count} session(s)`);
  console.log('  sample titles:');
  for (const s of summaries.slice(0, 3)) console.log(`    - ${s.firstMessage}`);
  console.log(`    ... (${summaries.length - 6} more)`);
  for (const s of summaries.slice(-3)) console.log(`    - ${s.firstMessage}`);

  // ------------------------------------------- DEV-10 unreadable date dir ---
  heading(`DEV-10 dry run: chmod 000 ${CHMOD_TARGET}`);
  await chmod(CHMOD_TARGET, 0o000);
  try {
    t = process.hrtime.bigint();
    let codexProjects = 'n/a';
    let codexError = null;
    try {
      const degraded = await codexScanner.scan();
      codexProjects = `${degraded.length} session(s)`;
    } catch (error) {
      codexError = `${error?.code ?? error?.name}: ${error?.message}`;
    }
    console.log(`CodexSessionScanner.scan() -> ${codexError ?? codexProjects} (${ms(t)})`);

    // What the import panel actually calls: scanAllLegacySources over both.
    t = process.hrtime.bigint();
    const all = await m.scanAllLegacySources([
      m.claudeSourceImporter(claudeScanner),
      m.codexSourceImporter(codexScanner),
    ]);
    console.log(`scanAllLegacySources() -> ${all.length} project(s) in ${ms(t)}:`);
    for (const p of all) {
      console.log(`  [${p.sourceKind}] ${p.id} sessions=${p.sessionCount} path=${p.path}`);
    }
  } finally {
    await chmod(CHMOD_TARGET, 0o755);
    console.log(`restored mode 0755 on ${CHMOD_TARGET}`);
  }

  heading('control: same call with all dirs readable');
  const all2 = await m.scanAllLegacySources([
    m.claudeSourceImporter(claudeScanner),
    m.codexSourceImporter(codexScanner),
  ]);
  for (const p of all2) {
    console.log(`  [${p.sourceKind}] ${p.id} sessions=${p.sessionCount} path=${p.path}`);
  }

  // ------------------------------------- DEV-12 synthetic legacy bare rows --
  heading('DEV-12: SYNTHETIC legacy bare-row rollout (NOT a real Codex artefact)');
  const legacyScanner = new m.CodexSessionScanner(() => LEGACY_SESSIONS);
  const legacy = await legacyScanner.scan();
  console.log(`scan(): ${legacy.length} session(s)`);
  for (const s of legacy) {
    console.log(`  ${s.sessionId}  cwd=${s.workspacePath}  title=${s.firstMessage}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
