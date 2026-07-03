#!/usr/bin/env node
// inject.ts — Hook injection script for Claude Code session/prompt hooks.

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  PROJECT_ROOT, WORKFLOW_PATH, SPEC_DIR, readText, loadConfig,
} from './lib/config.js';
import type { Proposal, StateFile } from './lib/schema.js';
import { readRepoIndex, readProposal, readState, findProposalDir } from './lib/store.js';
import {
  resolveActiveProposalId, resolveSessionKey, readLastActiveSession,
  readSession, writeSession,
} from './lib/session-runtime.js';

const STALL_WARN_THRESHOLD = 3;

// --- Workflow state block extraction ---

function extractWorkflowBlock(node: string): string {
  const content = readText(WORKFLOW_PATH);
  const marker = `[workflow-state:${node}]`;
  const idx = content.indexOf(marker);
  if (idx < 0) return '';
  const start = idx + marker.length;
  const nextMarker = content.indexOf('[workflow-state:', start);
  const block = nextMarker > 0 ? content.slice(start, nextMarker) : content.slice(start);
  return block.trim();
}

// --- Mode: session ---

function injectSession(): void {
  const index = readRepoIndex();
  const activeProposals = index.proposals.filter(p =>
    p.lifecycle_status === 'active' || p.lifecycle_status === 'blocked'
  );

  const lines: string[] = [];
  lines.push('<vflow-session>');

  if (activeProposals.length === 0) {
    lines.push('No active proposals. To start a new proposal:');
    lines.push('  node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type feature --tier T2');
  } else {
    lines.push(`Active proposals (${activeProposals.length}):`);
    for (const p of activeProposals) {
      lines.push(`  ${p.id} [${p.lifecycle_status}] ${p.title}`);
    }
    if (activeProposals.length === 1) {
      lines.push(`\nCurrent: ${activeProposals[0].id} — ${activeProposals[0].title}`);
    }
  }

  // Workflow overview — hand the AI the full process map up-front so it doesn't
  // reverse-engineer the lifecycle mid-task. Single source: workflow.md
  // [workflow-state:overview]. DRY.
  const overview = extractWorkflowBlock('overview');
  if (overview) {
    lines.push('');
    lines.push(overview);
  }

  // Spec index
  const specIndex = join(SPEC_DIR, 'index.md');
  if (existsSync(specIndex)) {
    const specContent = readText(specIndex);
    if (specContent) {
      lines.push(`\nSpec library (${specIndex}):`);
      lines.push(specContent.trim());
    } else {
      lines.push('\nSpec library available at .vflow/spec/');
    }
  }

  // Global collaboration baseline — unlike other specs (loaded on demand at
  // implement/review time), basic.md is session-level working discipline
  // (language, think-before-acting, minimalism...). Inject its full body every
  // session so the AI operates under it from the first turn, not just its index row.
  const basicSpec = join(SPEC_DIR, 'common', 'basic.md');
  if (existsSync(basicSpec)) {
    const basicContent = readText(basicSpec);
    if (basicContent) {
      lines.push(`\nGlobal baseline (${basicSpec}) — applies every turn:`);
      lines.push(basicContent.trim());
    }
  }

  lines.push('</vflow-session>');
  process.stdout.write(lines.join('\n') + '\n');
}

// --- Mode: prompt ---

const T1_HINT = [
  'T1 (inline plan tier): no state.json/ledger.md for this proposal.',
  'Keep to the 3-line inline plan you stated at intake. No hard gates apply —',
  'self-check your work, then run `accept` when done.',
].join('\n');

function injectSpecRefs(state: StateFile, lines: string[]): void {
  const refs = state.spec_refs.filter(r => r.file !== 'none');
  if (!refs.length) return;
  lines.push('');
  lines.push('--- Spec References (declared before entering build) ---');
  for (const ref of refs) {
    const path = isAbsolute(ref.file) ? ref.file : join(PROJECT_ROOT, ref.file);
    lines.push(`\n[${ref.file}] — ${ref.reason}`);
    if (!existsSync(path)) {
      lines.push(`(WARNING: file not found at ${path})`);
      continue;
    }
    const content = readText(path).trim();
    lines.push('```');
    lines.push(content);
    lines.push('```');
  }
}

function injectItemQueue(state: StateFile, lines: string[]): void {
  const doing = state.items.find(i => i.status === 'doing');
  const todo = state.items.filter(i => i.status === 'todo');
  const blocked = state.items.filter(i => i.status === 'blocked');
  const done = state.items.filter(i => i.status === 'done').length;

  lines.push('');
  lines.push('--- Item Queue (serial: one doing at a time) ---');
  if (doing) lines.push(`ACTIVE: ${doing.id} — ${doing.title}`);
  if (todo.length) lines.push(`TODO: ${todo.map(i => `${i.id}(${i.title})`).join(', ')}`);
  if (blocked.length) lines.push(`BLOCKED: ${blocked.map(i => `${i.id}(${i.note ?? 'no reason'})`).join(', ')}`);
  lines.push(`Progress: ${done}/${state.items.length} done`);
}

// Stagnation warning: if the pointer hasn't moved across consecutive prompts,
// nudge the AI to either act or check in with the user instead of idling.
function checkStagnation(sessionKey: string | null, pointer: string, lines: string[]): void {
  if (!sessionKey) return;
  const session = readSession(sessionKey);
  if (!session) return;

  if (session.last_seen_pointer === pointer) {
    session.pointer_stall_count = (session.pointer_stall_count ?? 0) + 1;
  } else {
    session.pointer_stall_count = 0;
    session.last_seen_pointer = pointer;
  }
  writeSession(session);

  if (session.pointer_stall_count >= STALL_WARN_THRESHOLD) {
    lines.push('');
    lines.push(`WARNING: pointer has stayed at '${pointer}' for ${session.pointer_stall_count} prompts. ` +
      'If work is genuinely stuck, use `move --to <node>` (or accept/checkpoint) to make progress, or surface the blocker to the user.');
  }
}

function injectPrompt(payload?: Record<string, unknown>): void {
  const repoFallback = () => {
    const index = readRepoIndex();
    const active = index.proposals.filter(p => p.lifecycle_status === 'active');
    return active.length === 1 ? active[0].id : null;
  };

  const { id: proposalId } = resolveActiveProposalId(payload, repoFallback);

  const lines: string[] = [];
  lines.push('<vflow-prompt>');

  if (!proposalId) {
    const config = loadConfig();
    const gateEnabled = config.features?.gate ?? true; // Default: enabled

    if (gateEnabled) {
      lines.push('MANDATORY: No active proposal exists. Before any code change, you MUST:');
      lines.push('');
      lines.push('1. Invoke the intake skill: Skill("vflow-go")');
      lines.push('2. The skill will classify tier (T0-T3) and create a proposal for T1+');
      lines.push('3. T0 tasks (pure questions) are answered directly without a proposal');
      lines.push('');
      lines.push('DO NOT attempt Write/Edit/NotebookEdit without a proposal — the PreToolUse hook will block you.');
    } else {
      const block = extractWorkflowBlock('no_proposal');
      if (block) lines.push(block);
      else lines.push('No active proposal. Create one with: node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type feature --tier T2');
    }

    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const dir = findProposalDir(proposalId);
  if (!dir) {
    lines.push(`Proposal ${proposalId} directory not found.`);
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const proposal: Proposal | null = readProposal(dir);
  if (!proposal) {
    lines.push(`Cannot read proposal.json for ${proposalId}.`);
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  lines.push(`Proposal: ${proposal.id} — ${proposal.title}`);
  lines.push(`Lifecycle: ${proposal.lifecycle_status} | Tier: ${proposal.tier} | Type: ${proposal.type}`);

  if (proposal.blocking.status === 'blocked') {
    lines.push(`BLOCKED: ${proposal.blocking.reason ?? proposal.blocking.type ?? 'unknown'}`);
  }

  if (proposal.tier === 'T1') {
    lines.push('');
    lines.push(T1_HINT);
    lines.push('');
    lines.push('CLI: node .vflow/scripts/dist/proposal.js <command>');
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const state = readState(dir);
  if (!state) {
    lines.push(`WARNING: state.json not found for ${proposal.id} (tier ${proposal.tier}).`);
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  lines.push(`Pointer: ${state.pointer} | History: ${state.history_stack.join(' -> ')}`);

  // Node-specific workflow block
  const block = extractWorkflowBlock(state.pointer);
  if (block) {
    lines.push('');
    lines.push(block);
  }

  // build: inject declared spec_refs' full content every turn (fixes the v2 bug
  // where spec_refs were only ever injected once, at session start).
  if (state.pointer === 'build') {
    injectSpecRefs(state, lines);
    injectItemQueue(state, lines);
  }

  // check: merges the old pending_acceptance hint — surface that the user still
  // needs to run `accept` to finish.
  if (state.pointer === 'check') {
    const sessionKey = resolveSessionKey(payload) ?? readLastActiveSession();
    if (sessionKey) {
      const session = readSession(sessionKey);
      if (session?.pending_user_confirmation) {
        lines.push('');
        lines.push('Session hint: pending_user_confirmation=true. Pause, report goal/state/diff/verification/risks, and ask the user. Only after explicit approval run `accept --user-approved`.');
      }
    }
  }

  const sessionKey = resolveSessionKey(payload) ?? readLastActiveSession();
  checkStagnation(sessionKey, state.pointer, lines);

  lines.push('');
  lines.push('CLI: node .vflow/scripts/dist/proposal.js <command>');
  lines.push('</vflow-prompt>');
  process.stdout.write(lines.join('\n') + '\n');
}

// --- Entrypoint ---

const mode = process.argv[2];
let payload: Record<string, unknown> | undefined;

// Read stdin payload if available (non-blocking)
try {
  const stdin = readFileSync(0, 'utf-8').trim();
  if (stdin) payload = JSON.parse(stdin);
} catch {
  // No stdin or invalid JSON — that's fine
}

if (mode === 'session') {
  injectSession();
} else if (mode === 'prompt') {
  injectPrompt(payload);
} else {
  console.error('Usage: inject.js <session|prompt>');
  process.exit(1);
}
