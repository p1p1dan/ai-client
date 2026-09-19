#!/usr/bin/env node

// T032 DEV-10/11/12/13 (import-up-01/03/04) sample generator.
//
// Builds two fake config homes under /tmp/t032/samples:
//   claude-home/  -> point CLAUDE_CONFIG_DIR at it
//   codex-home/   -> point CODEX_HOME at it
//
// Shapes follow the real scanners:
//   src/main/services/legacyImport/ClaudeSessionScanner.ts
//   src/main/services/legacyImport/CodexSessionScanner.ts
//   src/main/services/legacyImport/CodexRollout.ts
//
// Usage:
//   node /tmp/t032/samples/make-samples.mjs            # normal set (~36 MB on disk)
//   node /tmp/t032/samples/make-samples.mjs --huge     # ALSO writes a >64 MiB Claude file
//
// Nothing in the repo is touched.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = '/tmp/t032/samples';
const CLAUDE_HOME = join(ROOT, 'claude-home');
const CODEX_HOME = join(ROOT, 'codex-home');
const CODEX_LEGACY_SYNTHETIC = join(ROOT, 'codex-legacy-synthetic');

// Real workspace path so an actual import lands somewhere that exists.
const WORKSPACE = '/home/ai/code/ai-client';
// Claude Code encodes the cwd by replacing every '/' with '-'.
const CLAUDE_PROJECT_DIR = WORKSPACE.replaceAll('/', '-');

const HUGE = process.argv.includes('--huge');

function iso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 10, 0, 0, 0) + offsetMs).toISOString();
}

// ---------------------------------------------------------------- Claude ----

/**
 * One Claude Code session JSONL.
 *
 * Scanner rules honoured here:
 *  - file lives in <CLAUDE_CONFIG_DIR>/projects/<projectDir>/<sessionId>.jsonl
 *  - name must end in .jsonl and must NOT start with "agent-" (isSessionJsonlFile)
 *  - sessionId = basename without .jsonl, must be a safe path segment
 *  - listing preview reads only the first 300 lines + the last 50 lines
 *  - firstMessage = first `type:"user"` line's text, system tags stripped, cut to 80 chars
 *  - model = first `type:"system", subtype:"init"` line's `model`
 *  - workspace path = first `system/init` line's `cwd`, else any line's `cwd`
 */
async function writeClaudeSession({ filePath, sessionId, title, rounds, fillerChars }) {
  const stream = createWriteStream(filePath);
  const write = (obj) =>
    new Promise((resolve, reject) => {
      const ok = stream.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else stream.once('drain', resolve);
    });

  let t = 0;
  await write({
    type: 'system',
    subtype: 'init',
    cwd: WORKSPACE,
    model: 'claude-sonnet-5',
    sessionId,
    timestamp: iso(t),
    uuid: randomUUID(),
    version: '2.1.270',
  });

  let previous = null;
  for (let i = 0; i < rounds; i++) {
    // Filler is plain ASCII with no '<' so stripSystemTags() cannot eat it and
    // the Codex-style "synthetic user turn" heuristics stay irrelevant here.
    const chunk = `filler-${String(i).padStart(5, '0')}-`;
    const filler = chunk.repeat(Math.max(1, Math.ceil(fillerChars / chunk.length)));
    const userUuid = randomUUID();
    t += 1000;
    await write({
      parentUuid: previous,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: i === 0 ? `${title} / round 0 / ${filler}` : `round ${i} question / ${filler}`,
          },
        ],
      },
      uuid: userUuid,
      timestamp: iso(t),
      userType: 'external',
      entrypoint: 'cli',
      cwd: WORKSPACE,
      sessionId,
      version: '2.1.270',
      gitBranch: 'feat/runtime-evolution',
    });

    const assistantUuid = randomUUID();
    t += 1000;
    await write({
      parentUuid: userUuid,
      isSidechain: false,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: `round ${i} answer / ${filler}` }],
      },
      uuid: assistantUuid,
      timestamp: iso(t),
      userType: 'external',
      entrypoint: 'cli',
      cwd: WORKSPACE,
      sessionId,
      version: '2.1.270',
      gitBranch: 'feat/runtime-evolution',
    });
    previous = assistantUuid;
  }

  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
  const info = await stat(filePath);
  return info.size;
}

// ----------------------------------------------------------------- Codex ----

/**
 * One CURRENT-format Codex rollout: every line is {timestamp, type, payload}.
 *
 * Listing rules honoured here (CodexSessionScanner.scan + parseCodexRollout):
 *  - <CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl  (walk stops at depth 3)
 *  - needs a `session_meta` line whose payload has non-empty `id` AND `cwd`
 *  - needs >= 1 parsed user entry AND >= 1 parsed assistant entry, else it is
 *    silently skipped
 *  - a user message whose text starts with '<', '# AGENTS.md' or 'You are Codex'
 *    is treated as synthetic and dropped, so the title text must not start that way
 *  - firstMessage (the panel title) = first surviving user text, cut to 256 chars
 */
function codexRolloutLines({ sessionId, title, startMs }) {
  const rows = [];
  const push = (type, payload, offset) =>
    rows.push({ timestamp: iso(startMs + offset), type, payload });

  push(
    'session_meta',
    {
      session_id: sessionId,
      id: sessionId,
      timestamp: iso(startMs),
      cwd: WORKSPACE,
      originator: 't032-sample',
      cli_version: '0.149.1',
      source: 'vscode',
    },
    0
  );
  push('turn_context', { turn_id: randomUUID(), cwd: WORKSPACE, model: 'gpt-5-codex' }, 10);
  // Synthetic repo-instruction turn: the parser must drop this one.
  push(
    'response_item',
    {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'user',
      content: [
        { type: 'input_text', text: `# AGENTS.md instructions for ${WORKSPACE}\nignore me` },
      ],
    },
    20
  );
  // The real first user turn -> becomes the list title.
  push(
    'response_item',
    {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'user',
      content: [{ type: 'input_text', text: title }],
    },
    30
  );
  push(
    'response_item',
    {
      type: 'reasoning',
      id: `rs_${randomUUID()}`,
      summary: [{ type: 'summary_text', text: `Planning: ${title}` }],
    },
    40
  );
  const callId = `call_${randomUUID().slice(0, 12)}`;
  push(
    'response_item',
    {
      type: 'function_call',
      id: `fc_${randomUUID()}`,
      call_id: callId,
      name: 'shell',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }),
    },
    50
  );
  push(
    'response_item',
    {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ output: 'README.md\npackage.json\n', metadata: { exit_code: 0 } }),
    },
    60
  );
  push(
    'response_item',
    {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: `Answer for ${title}. ${'padding '.repeat(180)}`,
        },
      ],
      phase: 'final_answer',
    },
    70
  );
  push('event_msg', { type: 'task_complete', last_agent_message: `done: ${title}` }, 80);
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

/**
 * LEGACY (bare-row) Codex rollout. SYNTHETIC — hand-written from the parser's
 * own doc comment (CodexRollout.ts:38-49) and the fixture in
 * __tests__/CodexRollout.test.ts:70-101. It is NOT a real Codex artefact and
 * must never be reported as one.
 */
function legacyRolloutLines({ sessionId, title, startMs }) {
  const rows = [
    { id: sessionId, timestamp: iso(startMs), cwd: WORKSPACE },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: title }],
    },
    {
      type: 'function_call',
      call_id: 'call_legacy_1',
      name: 'shell',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }),
    },
    { type: 'function_call_output', call_id: 'call_legacy_1', output: 'README.md\n' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `legacy answer for ${title}` }],
    },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

// ------------------------------------------------------------------ main ----

const TOPICS = [
  'worktree',
  'terminal',
  'editor',
  'runtime',
  'permission',
  'session',
  'plugin',
  'model',
  'import',
  'trace',
  'worker',
  'scratch',
  'vault',
  'catalog',
  'theme',
  'telemetry',
];

async function main() {
  await rm(CLAUDE_HOME, { recursive: true, force: true });
  await rm(CODEX_HOME, { recursive: true, force: true });
  await rm(CODEX_LEGACY_SYNTHETIC, { recursive: true, force: true });

  const report = { claude: [], codex: { total: 0, byDate: {} }, legacySynthetic: [] };

  // --- Claude -------------------------------------------------------------
  const projectDir = join(CLAUDE_HOME, 'projects', CLAUDE_PROJECT_DIR);
  await mkdir(projectDir, { recursive: true });

  const bigId = '0a5f2c31-7b44-4d0e-9f61-t032bigsample'.replace('t032bigsample', 'a1b2c3d4e5f6');
  const bigPath = join(projectDir, `${bigId}.jsonl`);
  // 3000 rounds = 6000 conversation entries -> trips LEGACY_IMPORT_MAX_ENTRIES
  // (4000) partway through, at roughly 35 MiB on disk.
  const bigSize = await writeClaudeSession({
    filePath: bigPath,
    sessionId: bigId,
    title: 'T032 DEV-11 oversize sample (~35 MiB)',
    rounds: 3000,
    fillerChars: 5661,
  });
  report.claude.push({ file: bigPath, bytes: bigSize, note: 'oversize sample' });

  const smallId = 'b7c81d92-3e40-4a55-8c11-d0e1f2a3b4c5';
  const smallPath = join(projectDir, `${smallId}.jsonl`);
  const smallSize = await writeClaudeSession({
    filePath: smallPath,
    sessionId: smallId,
    title: 'T032 DEV-11 control sample (~50 KiB)',
    rounds: 8,
    fillerChars: 2560,
  });
  report.claude.push({ file: smallPath, bytes: smallSize, note: 'control sample' });

  if (HUGE) {
    const hugeId = 'c9d0e1f2-a3b4-4c5d-8e6f-112233445566';
    const hugePath = join(projectDir, `${hugeId}.jsonl`);
    // > LEGACY_IMPORT_MAX_SOURCE_BYTES (64 MiB) so the byte guard itself fires.
    const hugeSize = await writeClaudeSession({
      filePath: hugePath,
      sessionId: hugeId,
      title: 'T032 DEV-11 byte-cap sample (>64 MiB)',
      rounds: 3800,
      fillerChars: 8380,
    });
    report.claude.push({ file: hugePath, bytes: hugeSize, note: 'byte-cap sample (--huge)' });
  }

  // --- Codex (current format, 320 rollouts over 6 date dirs) ---------------
  const layout = [
    ['2026', '09', '10', 60],
    ['2026', '09', '11', 60],
    ['2026', '09', '12', 40], // <-- DEV-10 chmod 000 target
    ['2026', '09', '13', 60],
    ['2026', '09', '14', 60],
    ['2026', '09', '15', 40],
  ];
  let counter = 0;
  for (const [yyyy, mm, dd, count] of layout) {
    const dir = join(CODEX_HOME, 'sessions', yyyy, mm, dd);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      counter += 1;
      const sessionId = randomUUID();
      const topic = TOPICS[counter % TOPICS.length];
      const title = `T032 bulk rollout #${String(counter).padStart(3, '0')} ${yyyy}-${mm}-${dd} topic=${topic}`;
      const hh = String(i % 24).padStart(2, '0');
      const mi = String((i * 7) % 60).padStart(2, '0');
      const name = `rollout-${yyyy}-${mm}-${dd}T${hh}-${mi}-00-${sessionId}.jsonl`;
      await writeFile(
        join(dir, name),
        codexRolloutLines({
          sessionId,
          title,
          startMs: Date.UTC(2026, 8, Number(dd), Number(hh), Number(mi)) - Date.UTC(2026, 8, 10),
        }),
        'utf8'
      );
    }
    report.codex.byDate[`${yyyy}/${mm}/${dd}`] = count;
    report.codex.total += count;
  }

  // --- Codex legacy bare-row: SYNTHETIC, kept OUT of codex-home -----------
  const legacyDir = join(CODEX_LEGACY_SYNTHETIC, 'sessions', '2026', '09', '16');
  await mkdir(legacyDir, { recursive: true });
  const legacyId = randomUUID();
  const legacyPath = join(legacyDir, `rollout-2026-09-16T09-00-00-${legacyId}.jsonl`);
  await writeFile(
    legacyPath,
    legacyRolloutLines({
      sessionId: legacyId,
      title: 'T032 SYNTHETIC legacy bare-row rollout (not a real Codex artefact)',
      startMs: 0,
    }),
    'utf8'
  );
  await writeFile(
    join(CODEX_LEGACY_SYNTHETIC, 'SYNTHETIC-DO-NOT-CLAIM-AS-REAL.txt'),
    [
      'The rollout under sessions/2026/09/16/ was hand-written by the T032 sample',
      'generator from the parser doc comment (CodexRollout.ts:38-49) and the unit',
      'fixture (__tests__/CodexRollout.test.ts:70-101).',
      '',
      'It is NOT produced by any real Codex version. DEV-12 asks for a real legacy',
      'rollout; this file cannot satisfy that and must not be recorded as if it did.',
      '',
    ].join('\n'),
    'utf8'
  );
  report.legacySynthetic.push(legacyPath);

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
