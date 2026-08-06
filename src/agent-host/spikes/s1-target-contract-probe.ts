/**
 * S1 spike (our-side target contract): a STATIC probe over the AiClient
 * protocol surface, answering the three questions a second agent (Codex)
 * integration is estimated from:
 *
 *   1. Which RuntimeEvent types exist, and which Host file:line actually
 *      emits each one — an event nobody emits is a contract slot a second
 *      agent may leave empty for free; an event with emitters is real work.
 *   2. Where Claude/CLI semantics leak into the shared protocol (field names
 *      and enum values that only the Claude Agent SDK / cli.js produces).
 *      Every hit is debt a non-Claude agent must either fill or fake.
 *   3. How eventNormalizer.ts's 1200 lines split between agent-agnostic
 *      emitters/lifecycle and Claude-shape-specific ingestion — the only
 *      hard number behind "what does a Codex normalizer cost".
 *
 * No network, no model call, no repo mutation: it only reads source files.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s1-target-contract-probe.ts
 *
 * Optional:
 *   AICLIENT_S1_JSON=1        # emit machine-readable JSON after the report
 *
 * Failure modes are explicit: if a file is missing or the RuntimeEventType
 * union cannot be parsed the probe prints WHICH step failed and exits 1
 * rather than reporting a partial inventory as if it were complete.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_HOST_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(AGENT_HOST_DIR, '..', '..');

const RUNTIME_EVENTS = join(REPO_ROOT, 'src/shared/types/runtimeEvents.ts');
const AGENT_HOST_PROTOCOL = join(REPO_ROOT, 'src/shared/types/agentHost.ts');
const SESSION_HISTORY = join(REPO_ROOT, 'src/shared/types/sessionHistory.ts');
const NORMALIZER = join(AGENT_HOST_DIR, 'eventNormalizer.ts');

/** Host source files that may emit RuntimeEvents. */
const EMITTER_FILES = [
  'index.ts',
  'claudeRuntime.ts',
  'eventNormalizer.ts',
  'permissionBridge.ts',
  'questionBridge.ts',
].map((f) => join(AGENT_HOST_DIR, f));

function rel(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

function read(path: string, step: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAILED at step "${step}": cannot read ${path}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. RuntimeEventType inventory + emitter map
// ---------------------------------------------------------------------------

function parseEventTypes(source: string): string[] {
  const start = source.indexOf('export type RuntimeEventType =');
  if (start < 0) {
    console.error('FAILED at step "parse RuntimeEventType": union declaration not found');
    process.exit(1);
  }
  const end = source.indexOf(';', start);
  const body = source.slice(start, end);
  const names = [...body.matchAll(/'([a-z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    console.error('FAILED at step "parse RuntimeEventType": union parsed to zero members');
    process.exit(1);
  }
  return names;
}

interface EmitSite {
  file: string;
  line: number;
}

function findEmitSites(eventTypes: string[]): Map<string, EmitSite[]> {
  const map = new Map<string, EmitSite[]>(eventTypes.map((t) => [t, []]));
  for (const file of EMITTER_FILES) {
    const lines = read(file, `scan emitters in ${rel(file)}`).split('\n');
    lines.forEach((text, index) => {
      const match = text.match(/type:\s*'([a-z]+\.[a-zA-Z]+)'/);
      if (!match) return;
      const sites = map.get(match[1]);
      if (!sites) return;
      sites.push({ file: rel(file), line: index + 1 });
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 2. Claude-semantics leak scan
// ---------------------------------------------------------------------------

/**
 * Tokens that are Claude-Code / Anthropic-SDK specific. A hit inside a SHARED
 * protocol type means a second agent must supply that concept (or the field
 * stays permanently empty for it).
 */
const LEAK_PATTERNS: Array<{ id: string; re: RegExp; why: string }> = [
  { id: 'runtimeIdentity', re: /runtimeIdentity/, why: 'Claude CLI session id / --resume handle' },
  { id: 'cometix', re: /cometix/i, why: 'pinned Claude Code CLI package' },
  { id: 'agent-sdk-driver', re: /'agent-sdk'|'stream-json'/, why: 'Claude Code driver routes' },
  {
    id: 'permissionMode',
    re: /permissionMode|acceptEdits|bypassPermissions|dontAsk/,
    why: 'Agent SDK PermissionMode union',
  },
  {
    id: 'effort',
    re: /EffortLevel|SessionEffortLevel|'xhigh'/,
    why: 'Agent SDK top-level effort option',
  },
  {
    id: 'thinking-config',
    re: /thinking:\s*THINKING_CONFIG|adaptive|summarized/,
    why: 'Anthropic extended-thinking config',
  },
  { id: 'AskUserQuestion', re: /AskUserQuestion/, why: 'Claude-only built-in tool' },
  { id: 'parent_tool_use_id', re: /parent_tool_use_id/, why: 'SDK subagent segregation key' },
  {
    id: 'task_control',
    re: /task_started|task_progress|task_updated|task_notification/,
    why: 'cli.js system/task_* control events',
  },
  { id: 'tool_use_result', re: /tool_use_result/, why: 'SDK structured subagent report' },
  { id: 'api_retry', re: /api_retry|SessionRetryInfo/, why: 'cli.js transport retry loop' },
  {
    id: 'claude-paths',
    re: /~\/\.claude|\.claude\/projects|claude-agent-sdk/,
    why: 'Claude on-disk transcript / SDK package',
  },
  { id: 'jsonl-history', re: /JSONL|jsonl/, why: 'Claude Code transcript format' },
  { id: 'cli-stderr', re: /cli-stderr|stderrRedaction/, why: 'CLI child stderr passthrough' },
  { id: 'agentID', re: /agentID|agentId|agentType/, why: 'SDK subagent identity fields' },
];

interface LeakHit {
  id: string;
  why: string;
  file: string;
  line: number;
  text: string;
}

function scanLeaks(files: string[]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const file of files) {
    const lines = read(file, `leak scan ${rel(file)}`).split('\n');
    lines.forEach((text, index) => {
      for (const pattern of LEAK_PATTERNS) {
        if (pattern.re.test(text)) {
          hits.push({
            id: pattern.id,
            why: pattern.why,
            file: rel(file),
            line: index + 1,
            text: text.trim().slice(0, 100),
          });
        }
      }
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 3. eventNormalizer region accounting
// ---------------------------------------------------------------------------

type Bucket = 'agnostic' | 'claude-shape' | 'subagent-t34' | 'infra';

/**
 * Region table for eventNormalizer.ts. Each entry anchors on a literal source
 * line so the accounting cannot silently drift when the file changes: a
 * missing anchor is reported as a FAILURE, not skipped.
 */
const NORMALIZER_REGIONS: Array<{ anchor: string; label: string; bucket: Bucket }> = [
  {
    anchor: '/**\n * Convert Claude Agent SDK messages',
    label: 'file header doc',
    bucket: 'infra',
  },
  {
    anchor: 'import {\n  clampSubagentText,',
    label: 'subagent projection imports',
    bucket: 'subagent-t34',
  },
  { anchor: 'export type EmitFn', label: 'emit/log types', bucket: 'infra' },
  {
    anchor: 'interface NormalizerState',
    label: 'turn state (incl. 4 T-34 fields)',
    bucket: 'infra',
  },
  { anchor: 'function newState()', label: 'state reset', bucket: 'infra' },
  {
    anchor: 'export interface TurnAttachmentInput',
    label: 'attachment input type',
    bucket: 'agnostic',
  },
  {
    anchor: 'function extractTextParts',
    label: 'Anthropic content-block: text',
    bucket: 'claude-shape',
  },
  {
    anchor: 'function extractThinkingParts',
    label: 'Anthropic content-block: thinking',
    bucket: 'claude-shape',
  },
  { anchor: 'interface ToolUseBlock', label: 'tool_use block type', bucket: 'claude-shape' },
  {
    anchor: 'function extractToolUses',
    label: 'Anthropic content-block: tool_use',
    bucket: 'claude-shape',
  },
  {
    anchor: 'function extractToolResults',
    label: 'Anthropic content-block: tool_result',
    bucket: 'claude-shape',
  },
  { anchor: 'function readString', label: 'T-34 helper: readString', bucket: 'subagent-t34' },
  {
    anchor: 'function readFiniteNumber',
    label: 'T-34 helper: readFiniteNumber',
    bucket: 'subagent-t34',
  },
  {
    anchor: 'function normalizeSubagentUsage',
    label: 'T-34: usage normalization',
    bucket: 'subagent-t34',
  },
  {
    anchor: 'function normalizeSubagentRunStatus',
    label: 'T-34: CLI status enum',
    bucket: 'subagent-t34',
  },
  {
    anchor: 'function detectSubagentReport',
    label: 'T-34: tool_use_result report',
    bucket: 'subagent-t34',
  },
  { anchor: 'export class EventNormalizer', label: 'class head + ctor', bucket: 'infra' },
  { anchor: '  beginTurn(', label: 'user-turn echo', bucket: 'agnostic' },
  { anchor: '  private ensureAssistant(', label: 'assistant envelope', bucket: 'agnostic' },
  { anchor: '  private emitTextDelta(', label: 'emit text delta', bucket: 'agnostic' },
  { anchor: '  private emitThinkingDelta(', label: 'emit thinking delta', bucket: 'agnostic' },
  { anchor: '  private emitToolStarted(', label: 'emit tool.started', bucket: 'agnostic' },
  { anchor: '  private emitToolCompleted(', label: 'emit tool.completed', bucket: 'agnostic' },
  {
    anchor: '  private emitSubagentActivity(',
    label: 'T-34: activity emit + cap',
    bucket: 'subagent-t34',
  },
  {
    anchor: '  private ingestSubagentAssistant(',
    label: 'T-34: subagent assistant',
    bucket: 'subagent-t34',
  },
  { anchor: '  private ingestSubagentUser(', label: 'T-34: subagent user', bucket: 'subagent-t34' },
  {
    anchor: '  private ingestTaskControl(',
    label: 'T-34: system/task_* control',
    bucket: 'subagent-t34',
  },
  { anchor: '  ingest(', label: 'SDK message switch (mixed)', bucket: 'claude-shape' },
  { anchor: '  hasOpenTools()', label: 'open-tool probe', bucket: 'agnostic' },
  { anchor: '  emitFailed(', label: 'terminal: failed', bucket: 'agnostic' },
  { anchor: '  emitStopped(', label: 'terminal: stopped', bucket: 'agnostic' },
  { anchor: '  finishTurn(', label: 'terminal: synthetic close', bucket: 'agnostic' },
];

interface RegionReport {
  label: string;
  bucket: Bucket;
  startLine: number;
  endLine: number;
  total: number;
  code: number;
  comment: number;
  blank: number;
}

function classifyLines(lines: string[]): Array<'code' | 'comment' | 'blank'> {
  const out: Array<'code' | 'comment' | 'blank'> = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      out.push('comment');
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.length === 0) {
      out.push('blank');
      continue;
    }
    if (line.startsWith('/*')) {
      out.push('comment');
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//')) {
      out.push('comment');
      continue;
    }
    out.push('code');
  }
  return out;
}

function accountNormalizer(): { regions: RegionReport[]; totals: Record<Bucket, RegionReport> } {
  const source = read(NORMALIZER, 'eventNormalizer region accounting');
  const lines = source.split('\n');
  const kinds = classifyLines(lines);

  // Anchor → 1-based start line. Multi-line anchors are matched on the joined
  // source so a failure names the anchor that moved.
  const starts: number[] = [];
  let cursor = 0;
  for (const region of NORMALIZER_REGIONS) {
    const at = source.indexOf(region.anchor, cursor);
    if (at < 0) {
      console.error(
        `FAILED at step "region accounting": anchor not found (or out of order): ${JSON.stringify(region.anchor.slice(0, 40))}`
      );
      process.exit(1);
    }
    cursor = at + region.anchor.length;
    starts.push(source.slice(0, at).split('\n').length);
  }

  const regions: RegionReport[] = NORMALIZER_REGIONS.map((region, index) => {
    const startLine = starts[index];
    const endLine = index + 1 < starts.length ? starts[index + 1] - 1 : lines.length;
    const slice = kinds.slice(startLine - 1, endLine);
    return {
      label: region.label,
      bucket: region.bucket,
      startLine,
      endLine,
      total: slice.length,
      code: slice.filter((k) => k === 'code').length,
      comment: slice.filter((k) => k === 'comment').length,
      blank: slice.filter((k) => k === 'blank').length,
    };
  });

  const totals = {} as Record<Bucket, RegionReport>;
  for (const bucket of ['agnostic', 'claude-shape', 'subagent-t34', 'infra'] as Bucket[]) {
    const members = regions.filter((r) => r.bucket === bucket);
    totals[bucket] = {
      label: bucket,
      bucket,
      startLine: 0,
      endLine: 0,
      total: members.reduce((sum, r) => sum + r.total, 0),
      code: members.reduce((sum, r) => sum + r.code, 0),
      comment: members.reduce((sum, r) => sum + r.comment, 0),
      blank: members.reduce((sum, r) => sum + r.blank, 0),
    };
  }
  return { regions, totals };
}

/** Sub-accounting inside ingest(): per-case line spans of the big switch. */
function accountIngestSwitch(): Array<{
  label: string;
  startLine: number;
  endLine: number;
  total: number;
}> {
  const source = read(NORMALIZER, 'ingest switch accounting');
  const lines = source.split('\n');
  const anchors: Array<{ label: string; needle: string }> = [
    { label: 'ingest(): raw SDK msg shape typing', needle: '  ingest(raw: unknown' },
    { label: "case 'system' (task_* / init / api_retry)", needle: "        case 'system': {" },
    { label: "case 'assistant'", needle: "        case 'assistant': {" },
    { label: "case 'stream_event'", needle: "        case 'stream_event': {" },
    { label: "case 'user' (tool_result + T-34 report)", needle: "        case 'user': {" },
    { label: "case 'tool_progress'", needle: "        case 'tool_progress': {" },
    { label: "case 'result' (turn terminal)", needle: "        case 'result': {" },
    { label: 'default + catch', needle: '        default: {' },
    { label: '(end of ingest)', needle: '  /** A tool_use started this turn' },
  ];
  const starts = anchors.map((a) => {
    const at = source.indexOf(a.needle);
    if (at < 0) {
      console.error(`FAILED at step "ingest switch accounting": anchor missing: ${a.needle}`);
      process.exit(1);
    }
    return source.slice(0, at).split('\n').length;
  });
  const out: Array<{ label: string; startLine: number; endLine: number; total: number }> = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    out.push({
      label: anchors[i].label,
      startLine: starts[i],
      endLine: starts[i + 1] - 1,
      total: starts[i + 1] - starts[i],
    });
  }
  void lines;
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function main(): void {
  const runtimeSource = read(RUNTIME_EVENTS, 'read runtimeEvents.ts');
  const eventTypes = parseEventTypes(runtimeSource);
  const emitters = findEmitSites(eventTypes);

  console.log('='.repeat(78));
  console.log('S1 TARGET CONTRACT PROBE — our-side protocol surface (static, no network)');
  console.log('='.repeat(78));

  console.log(
    `\n[1] RuntimeEventType inventory: ${eventTypes.length} types (${rel(RUNTIME_EVENTS)})`
  );
  const unemitted: string[] = [];
  for (const type of eventTypes) {
    const sites = emitters.get(type) ?? [];
    if (sites.length === 0) unemitted.push(type);
    const where = sites.map((s) => `${s.file}:${s.line}`).join(', ') || '(no Host emitter found)';
    console.log(`  ${type.padEnd(24)} emitters=${String(sites.length).padStart(2)}  ${where}`);
  }
  console.log(
    `\n  types with ZERO Host emitter: ${unemitted.length ? unemitted.join(', ') : '(none)'}`
  );

  console.log('\n[2] Claude-semantics leaks in SHARED protocol types');
  const sharedHits = scanLeaks([RUNTIME_EVENTS, AGENT_HOST_PROTOCOL, SESSION_HISTORY]);
  const byId = new Map<string, LeakHit[]>();
  for (const hit of sharedHits) {
    const list = byId.get(hit.id) ?? [];
    list.push(hit);
    byId.set(hit.id, list);
  }
  for (const [id, hits] of [...byId.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${id} (${hits.length} hits) — ${hits[0].why}`);
    for (const hit of hits.slice(0, 6)) {
      console.log(`      ${hit.file}:${hit.line}  ${hit.text}`);
    }
    if (hits.length > 6) console.log(`      … ${hits.length - 6} more`);
  }
  console.log(`  TOTAL leak hits in shared types: ${sharedHits.length}`);

  console.log('\n[3] eventNormalizer.ts region accounting');
  const { regions, totals } = accountNormalizer();
  for (const region of regions) {
    console.log(
      `  ${String(region.startLine).padStart(4)}-${String(region.endLine).padEnd(4)} ` +
        `${region.bucket.padEnd(13)} total=${String(region.total).padStart(4)} ` +
        `code=${String(region.code).padStart(4)} cmt=${String(region.comment).padStart(4)}  ${region.label}`
    );
  }
  console.log('  ---');
  for (const bucket of ['agnostic', 'claude-shape', 'subagent-t34', 'infra'] as Bucket[]) {
    const t = totals[bucket];
    console.log(
      `  ${bucket.padEnd(13)} total=${String(t.total).padStart(4)} code=${String(t.code).padStart(4)} comment=${String(t.comment).padStart(4)} blank=${String(t.blank).padStart(4)}`
    );
  }
  const grandTotal = (Object.values(totals) as RegionReport[]).reduce((s, t) => s + t.total, 0);
  const grandCode = (Object.values(totals) as RegionReport[]).reduce((s, t) => s + t.code, 0);
  console.log(`  ALL           total=${grandTotal} code=${grandCode}`);

  console.log('\n[4] ingest() switch — per-case spans');
  for (const entry of accountIngestSwitch()) {
    console.log(
      `  ${String(entry.startLine).padStart(4)}-${String(entry.endLine).padEnd(4)} total=${String(entry.total).padStart(4)}  ${entry.label}`
    );
  }

  console.log('\n[5] Host command surface (src/shared/types/agentHost.ts)');
  const hostSource = read(AGENT_HOST_PROTOCOL, 'read agentHost.ts');
  const cmdStart = hostSource.indexOf('export type AgentHostCommandType =');
  const cmdBody = hostSource.slice(cmdStart, hostSource.indexOf(';', cmdStart));
  const commands = [...cmdBody.matchAll(/'([a-z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  console.log(`  ${commands.length} commands: ${commands.join(', ')}`);

  if (process.env.AICLIENT_S1_JSON === '1') {
    console.log('\n--- JSON ---');
    console.log(
      JSON.stringify(
        {
          eventTypes,
          unemitted,
          emitters: Object.fromEntries([...emitters.entries()].map(([k, v]) => [k, v])),
          sharedLeakHits: sharedHits,
          normalizerRegions: regions,
          normalizerTotals: totals,
          commands,
        },
        null,
        2
      )
    );
  }
}

main();
