#!/usr/bin/env node
// proposal.ts — CLI entry point for the vflow v3 proposal system.

import { createInterface } from 'node:readline';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { isoNow, KNOWLEDGE_DIR, loadConfig } from './lib/config.js';
import { POINTERS } from './lib/schema.js';
import type {
  Proposal, LifecycleStatus, ProposalType, Tier, Pointer,
  RepoIndexEntry, StateFile,
} from './lib/schema.js';
import {
  nextProposalId, proposalDir, findProposalDir,
  readProposal, writeProposal, readRepoIndex, upsertRepoIndex,
  readState, writeState, initLedger,
  findItem, setItemStatus,
} from './lib/store.js';
import {
  nextPointer, checkLedgerCaughtUp, checkGateBuild, checkGateDesignReconfirm,
  checkArchiveReady, canTransitionItem,
} from './lib/checks.js';
import {
  resolveCliProposalId, bindSession, resolveSessionKey,
  readLastActiveSession, updateSessionExecutionItem, updateSessionConfirmation,
} from './lib/session-runtime.js';

// --- Arg parsing ---

// 用户验收闸门。三条通道(优先级从高到低):
// 1. userApproved=true —— AI 在对话内已取得用户明确同意,转达执行(caller 把事件
//    from 记成 ai_relay,留痕可审计)。这是 AI 的正路:先暂停汇报征询,拿到用户对话
//    同意后带 --user-approved 重跑,而不是傻乎乎让用户滚去命令行自己敲。
// 2. TTY 交互 yes/no —— 用户自己在终端跑命令时亲自确认。
// 3. 非 TTY 读 stdin —— 测试/CI 与高级用户用管道喂 "yes" 的通道。
async function confirmByUser(prompt: string, userApproved = false): Promise<boolean> {
  if (userApproved) return true;
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(`${prompt} (yes/no): `, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
    });
    return answer === 'yes' || answer === 'y';
  }
  try {
    const data = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timeout = setTimeout(() => { process.stdin.removeAllListeners(); reject(new Error('timeout')); }, 200);
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('\n')) {
          clearTimeout(timeout);
          process.stdin.removeAllListeners();
          resolve(buf.split('\n')[0].trim().toLowerCase());
        }
      });
      process.stdin.on('end', () => {
        clearTimeout(timeout);
        process.stdin.removeAllListeners();
        resolve(buf.trim().toLowerCase());
      });
      process.stdin.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('stdin error'));
      });
      process.stdin.resume();
    });
    return data === 'yes' || data === 'y';
  } catch { return false; }
}

// --- Arg parsing helper ---

function parseArgs(args: string[]): { cmd: string; sub?: string; positional: string[]; flags: Record<string, string> } {
  const cmd = args[0] ?? '';
  const sub = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const startIdx = sub ? 2 : 1;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [key, ...rest] = a.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true');
    } else {
      positional.push(a);
    }
  }
  return { cmd, sub, positional, flags };
}

// --- Resolve current proposal ---

function resolveProposal(flags: Record<string, string>): { dir: string; proposal: Proposal } | null {
  let id: string | null = flags['id'] ?? null;
  if (!id) {
    const repoFallback = () => {
      const index = readRepoIndex();
      const active = index.proposals.filter(p => p.lifecycle_status === 'active');
      return active.length === 1 ? active[0].id : null;
    };
    const resolved = resolveCliProposalId(repoFallback);
    id = resolved.id;
  }
  if (!id) { console.log('No active proposal. Use --id or create one.'); return null; }
  const dir = findProposalDir(id);
  if (!dir) { console.log(`Proposal directory not found for '${id}'.`); return null; }
  const proposal = readProposal(dir);
  if (!proposal) { console.log(`Cannot read proposal.json in '${dir}'.`); return null; }
  return { dir, proposal };
}

function repoIndexEntry(dir: string, proposal: Proposal): RepoIndexEntry {
  return {
    id: proposal.id, slug: proposal.slug, dir: basename(dir), title: proposal.title,
    lifecycle_status: proposal.lifecycle_status, type: proposal.type, updated_at: isoNow(),
  };
}

// --- Commands ---

function cmdCreate(positional: string[], flags: Record<string, string>): void {
  const slug = positional[0] ?? flags['slug'];
  if (!slug) { console.log('Usage: create <slug> --title "..." --type feature --tier T2'); return; }
  const title = flags['title'] ?? slug;
  const type = (flags['type'] ?? 'feature') as ProposalType;
  const tier = (flags['tier'] ?? 'T2') as Tier;

  const id = nextProposalId();
  const dir = proposalDir(id, slug);
  mkdirSync(dir, { recursive: true });

  const proposal: Proposal = {
    id, title, slug,
    lifecycle_status: 'active',
    blocking: { status: 'none' },
    tier, type,
    workspace: { isolate_intent: false, branch: null },
    created_at: isoNow(),
    updated_at: isoNow(),
    schema_version: 2,
  };
  writeProposal(dir, proposal);
  upsertRepoIndex(repoIndexEntry(dir, proposal));

  if (tier !== 'T1') {
    const state: StateFile = {
      schema_version: 2,
      pointer: 'understand',
      history_stack: ['understand'],
      scope: '',
      items: [],
      spec_refs: [],
    };
    writeState(dir, state);
    initLedger(dir, id, title);
  }

  const sessionKey = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sessionKey) bindSession(sessionKey, id);

  console.log(`Created proposal ${id} (${slug}) [${tier}/${type}]`);
}

function cmdContinue(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const sessionKey = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sessionKey) {
    bindSession(sessionKey, resolved.proposal.id);
    console.log(`Session bound to ${resolved.proposal.id}`);
  } else {
    console.log('Cannot determine session key.');
  }
}

function cmdStatus(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { proposal, dir } = resolved;
  console.log(`Proposal: ${proposal.id} — ${proposal.title}`);
  console.log(`  Lifecycle: ${proposal.lifecycle_status} | Tier: ${proposal.tier} | Type: ${proposal.type}`);
  if (proposal.blocking.status === 'blocked') {
    console.log(`  Blocked: ${proposal.blocking.reason ?? 'unknown'}`);
  }
  console.log(`  Updated: ${proposal.updated_at}`);
  if (proposal.tier === 'T1') {
    console.log('  T1: inline plan only, no state.json/ledger.md.');
    return;
  }
  const state = readState(dir);
  if (!state) { console.log('  state.json not found.'); return; }
  console.log(`  Pointer: ${state.pointer} | History: ${state.history_stack.join(' -> ')}`);
  console.log(`  Scope: ${state.scope || '(empty)'}`);
  console.log(`  Spec refs: ${state.spec_refs.length ? state.spec_refs.map(r => r.file).join(', ') : '(none)'}`);
  const doing = state.items.find(i => i.status === 'doing');
  const done = state.items.filter(i => i.status === 'done').length;
  console.log(`  Items: ${done}/${state.items.length} done | Active: ${doing?.id ?? 'none'}`);
}

function cmdList(): void {
  const index = readRepoIndex();
  if (index.proposals.length === 0) { console.log('No proposals.'); return; }
  for (const p of index.proposals) {
    console.log(`  ${p.id} [${p.lifecycle_status}] ${p.title}`);
  }
}

function cmdMove(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  if (proposal.tier === 'T1') {
    console.log('T1 proposals have no state.json/pointer — nothing to move.');
    return;
  }

  const state = readState(dir);
  if (!state) { console.log(`state.json not found in '${dir}'.`); return; }

  const to = flags['to'] as Pointer | undefined;
  if (!to || !(POINTERS as readonly string[]).includes(to)) {
    console.log(`Usage: move --to <${POINTERS.join('|')}> [--scope "..."]`);
    return;
  }

  if (to === 'done') {
    console.log('Cannot move to done via `move` — use `accept` (Hard Gate 2 requires explicit user acceptance).');
    return;
  }

  const current = state.pointer;
  if (to === current) {
    console.log(`Already at '${current}'. A decide -> decide self-loop reconfirmation is hand-written directly into ledger.md, not via move.`);
    return;
  }

  const forwardOk = to === nextPointer(current);
  const backwardOk = state.history_stack.includes(to);
  if (!forwardOk && !backwardOk) {
    console.log(`Cannot move from '${current}' to '${to}': not the next node and not present in history_stack.`);
    return;
  }

  const ledgerCheck = checkLedgerCaughtUp(dir, state);
  if (!ledgerCheck.ok) {
    console.log('Cannot move — ledger.md is not caught up:');
    for (const e of ledgerCheck.errors) console.log(`  - ${e}`);
    return;
  }

  if (to === 'build') {
    const gate1 = checkGateBuild(flags['scope'], state.spec_refs);
    if (!gate1.ok) {
      console.log('Cannot move to build (Hard Gate 1):');
      for (const e of gate1.errors) console.log(`  - ${e}`);
      return;
    }
    if (current === 'decide' && proposal.tier === 'T3') {
      const gate1a = checkGateDesignReconfirm(dir, proposal.tier);
      if (!gate1a.ok) {
        console.log('Cannot move to build (Hard Gate 1a, T3 design reconfirmation):');
        for (const e of gate1a.errors) console.log(`  - ${e}`);
        return;
      }
    }
    state.scope = flags['scope']!.trim();
  }

  state.pointer = to;
  state.history_stack.push(to);
  writeState(dir, state);

  const sk = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sk) {
    if (to === 'check') updateSessionConfirmation(sk, true);
    else if (current === 'check') updateSessionConfirmation(sk, false);
  }

  console.log(`Moved: ${current} -> ${to}`);
  console.log('Remember to append the matching transition entry to ledger.md before the next move.');
}

function cmdItem(sub: string | undefined, positional: string[], flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  if (proposal.tier === 'T1') { console.log('T1 proposals have no state.json/items.'); return; }
  const state = readState(dir);
  if (!state) { console.log(`state.json not found in '${dir}'.`); return; }

  switch (sub) {
    case 'add': {
      const title = flags['title'] ?? positional[0];
      if (!title) { console.log('Usage: item add --title "..."'); return; }
      const id = `E-${String(state.items.length + 1).padStart(3, '0')}`;
      state.items.push({ id, title, status: 'todo' });
      writeState(dir, state);
      console.log(`Added item ${id}: ${title}`);
      break;
    }
    case 'start': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: item start --item E-001'); return; }
      const check = canTransitionItem(state, itemId, 'doing');
      if (!check.ok) { console.log(check.error); return; }
      setItemStatus(state, itemId, 'doing');
      writeState(dir, state);
      const sk = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk) updateSessionExecutionItem(sk, itemId);
      console.log(`Started item ${itemId}`);
      break;
    }
    case 'complete': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: item complete --item E-001 [--note "..."]'); return; }
      const check = canTransitionItem(state, itemId, 'done');
      if (!check.ok) { console.log(check.error); return; }
      const item = findItem(state, itemId)!;
      if (flags['note']) item.note = flags['note'];
      setItemStatus(state, itemId, 'done');
      writeState(dir, state);
      const sk2 = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk2) updateSessionExecutionItem(sk2, null);
      console.log(`Completed item ${itemId}`);
      break;
    }
    case 'block': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: item block --item E-001 [--note "..."]'); return; }
      const check = canTransitionItem(state, itemId, 'blocked');
      if (!check.ok) { console.log(check.error); return; }
      const item = findItem(state, itemId)!;
      if (flags['note']) item.note = flags['note'];
      setItemStatus(state, itemId, 'blocked');
      writeState(dir, state);
      const sk3 = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk3) updateSessionExecutionItem(sk3, null);
      console.log(`Blocked item ${itemId}`);
      break;
    }
    case 'cancel': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: item cancel --item E-001'); return; }
      const check = canTransitionItem(state, itemId, 'cancelled');
      if (!check.ok) { console.log(check.error); return; }
      const prev = findItem(state, itemId)!.status;
      setItemStatus(state, itemId, 'cancelled');
      writeState(dir, state);
      if (prev === 'doing') {
        const sk4 = resolveSessionKey(undefined) ?? readLastActiveSession();
        if (sk4) updateSessionExecutionItem(sk4, null);
      }
      console.log(`Cancelled item ${itemId}`);
      break;
    }
    default:
      console.log('Usage: item <add|start|complete|block|cancel>');
  }
}

function cmdSpecRef(sub: string | undefined, flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  if (proposal.tier === 'T1') { console.log('T1 proposals have no state.json/spec_refs.'); return; }
  const state = readState(dir);
  if (!state) { console.log(`state.json not found in '${dir}'.`); return; }

  if (sub === 'add') {
    const file = flags['file'];
    const reason = flags['reason'];
    if (!file || !reason) { console.log('Usage: spec-ref add --file <path> --reason "..."'); return; }
    state.spec_refs = state.spec_refs.filter(r => r.file !== 'none');
    state.spec_refs.push({ file, reason });
    writeState(dir, state);
    console.log(`Added spec-ref: ${file} (${reason})`);
  } else if (sub === 'none') {
    const reason = flags['reason'];
    if (!reason) { console.log('Usage: spec-ref none --reason "..."'); return; }
    state.spec_refs = [{ file: 'none', reason }];
    writeState(dir, state);
    console.log(`Declared no relevant spec: ${reason}`);
  } else {
    console.log('Usage: spec-ref <add|none>');
  }
}

function cmdSet(sub: string | undefined, flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  const value = flags['value'] ?? flags['to'];

  switch (sub) {
    case 'tier': {
      if (!value) { console.log('Usage: set tier --value T1'); return; }
      const isRecovery = flags['recovery'] === 'true';
      const prev = proposal.tier;
      const next = value as Tier;
      // Prevent cross-tier changes without explicit recovery flag
      if (!isRecovery && prev !== next && (prev === 'T3' || next === 'T3')) {
        console.log(`ERROR: Cannot change tier from ${prev} to ${next} without --recovery flag.`);
        console.log('Tier changes involving T3 require explicit recovery mode to prevent accidental downgrades.');
        console.log('If you are recovering from a misclassification, rerun: set tier --value ${next} --recovery true');
        return;
      }
      proposal.tier = next;
      writeProposal(dir, proposal);
      console.log(`Tier: ${prev} -> ${next}${isRecovery ? ' (recovery mode)' : ''}`);
      break;
    }
    case 'type': {
      if (!value) { console.log('Usage: set type --value bug'); return; }
      const prev = proposal.type;
      proposal.type = value as ProposalType;
      writeProposal(dir, proposal);
      console.log(`Type: ${prev} -> ${value}`);
      break;
    }
    case 'lifecycle': {
      if (!value) { console.log('Usage: set lifecycle --value on_hold'); return; }
      const isRecovery = flags['recovery'] === 'true';
      const prev = proposal.lifecycle_status;
      const next = value as LifecycleStatus;

      // Hard block: done and archived are gate-protected states
      if (!isRecovery && (next === 'done' || next === 'archived')) {
        console.log(`ERROR: Cannot set lifecycle to '${next}' directly.`);
        console.log(`'${next}' is a gate-protected state. Use the correct command instead:`);
        if (next === 'done') {
          console.log('  - To accept a proposal: node .vflow/scripts/dist/proposal.js accept');
        } else {
          console.log('  - To archive a proposal: node .vflow/scripts/dist/proposal.js archive');
        }
        console.log('');
        console.log('If you are recovering from data corruption, rerun: set lifecycle --value ${next} --recovery true');
        return;
      }

      proposal.lifecycle_status = next;
      writeProposal(dir, proposal);
      upsertRepoIndex(repoIndexEntry(dir, proposal));
      console.log(`Lifecycle: ${prev} -> ${next}${isRecovery ? ' (recovery mode)' : ''}`);
      break;
    }
    case 'blocking': {
      const reason = flags['reason'] ?? '';
      const type = flags['type'] ?? 'generic';
      if (value === 'none') {
        proposal.blocking = { status: 'none' };
      } else {
        proposal.blocking = { status: 'blocked', type, reason, since: isoNow() };
      }
      writeProposal(dir, proposal);
      console.log(`Blocking: ${JSON.stringify(proposal.blocking)}`);
      break;
    }
    default:
      console.log('Usage: set <tier|type|lifecycle|blocking> --value ...');
  }
}

async function cmdAccept(flags: Record<string, string>): Promise<void> {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  if (proposal.tier !== 'T1') {
    const state = readState(dir);
    if (!state) { console.log(`state.json not found in '${dir}'.`); return; }
    if (state.pointer !== 'check') {
      console.log(`Cannot accept: pointer is at '${state.pointer}', expected 'check'.`);
      return;
    }
  }

  const userApproved = flags['user-approved'] === 'true';
  if (!await confirmByUser(`Accept proposal ${proposal.id} "${proposal.title}"?`, userApproved)) {
    console.log('REJECTED: accept must be confirmed by user.');
    console.log('AI: pause first. Report goal / current state / diff-from-goal / verification results / risks to the user and ask. Only after explicit in-conversation approval, rerun `accept --user-approved` (logged as ai_relay). The user may also run `accept` in a terminal to confirm interactively.');
    return;
  }

  // Write audit trail
  const acceptedSource: 'user_terminal' | 'ai_relay' = userApproved ? 'ai_relay' : 'user_terminal';
  proposal.lifecycle_status = 'done';
  proposal.accepted_at = isoNow();
  proposal.accepted_by = acceptedSource === 'ai_relay' ? 'ai' : 'user';
  proposal.accepted_source = acceptedSource;
  writeProposal(dir, proposal);
  upsertRepoIndex(repoIndexEntry(dir, proposal));

  if (proposal.tier !== 'T1') {
    const state = readState(dir)!;
    state.pointer = 'done';
    state.history_stack.push('done');
    writeState(dir, state);
  }

  const skAccept = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (skAccept) updateSessionConfirmation(skAccept, false);

  console.log(`Accepted. Proposal ${proposal.id} is now done.`);
  console.log(`Audit: accepted_by=${proposal.accepted_by} source=${proposal.accepted_source} at=${proposal.accepted_at}`);
  if (proposal.tier !== 'T1') {
    console.log('Remember to append the matching `check -> done` transition entry to ledger.md.');
  }
}

function cmdArchive(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  const state = proposal.tier === 'T1' ? null : readState(dir);
  const gate = checkArchiveReady(proposal, state);
  if (!gate.ok) {
    console.log('Cannot archive:');
    for (const e of gate.errors) console.log(`  - ${e}`);
    return;
  }

  import('./lib/derive.js').then(({ archiveProposal }) => {
    archiveProposal(dir, proposal);
  });
}

function cmdCheckpoint(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  if (proposal.tier === 'T1') {
    console.log('T1 proposals have no ledger.md — nothing to checkpoint.');
    return;
  }

  const state = readState(dir);
  const node = state?.pointer ?? 'unknown';

  writeProposal(dir, proposal); // refresh updated_at as an observable "last checkpoint" signal

  console.log('Checkpoint template — append this block to ledger.md now (fill in the five lines):');
  console.log('');
  console.log(`## [${isoNow()}] CHECKPOINT @ ${node}`);
  console.log('- 已完成: ');
  console.log('- 未完成: ');
  console.log('- 关键文件: ');
  console.log('- 坑: ');
  console.log('- 下一步: ');
}

function cmdKnowledge(sub: string | undefined, flags: Record<string, string>): void {
  if (sub === 'suggest') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    import('./lib/derive.js').then(({ knowledgeSuggestGuidance }) => {
      for (const line of knowledgeSuggestGuidance()) console.log(line);
    });
  } else if (sub === 'save') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    const content = flags['content'];
    const reason = flags['reason'];
    if (!content) { console.log('Usage: knowledge save --content "..." --reason "..."'); return; }
    const config = loadConfig();
    const repoName = config.project || 'default';
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    const path = join(KNOWLEDGE_DIR, `${repoName}.md`);
    const entry = `\n## ${isoNow()}\n\n${content}\n\n> Reason: ${reason ?? 'N/A'}\n`;
    appendFileSync(path, entry, 'utf-8');
    resolved.proposal.knowledge_processed = true;
    writeProposal(resolved.dir, resolved.proposal);
    console.log(`Knowledge saved to ${path}`);
  } else if (sub === 'skip') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    resolved.proposal.knowledge_processed = true;
    writeProposal(resolved.dir, resolved.proposal);
    console.log('Knowledge candidates skipped. Marked as processed.');
  } else {
    console.log('Usage: knowledge <suggest|save|skip>');
  }
}

// --- Main ---

const args = process.argv.slice(2);
const { cmd, sub, positional, flags } = parseArgs(args);

switch (cmd) {
  case 'create': cmdCreate(sub ? [sub, ...positional] : positional, flags); break;
  case 'continue': cmdContinue(flags); break;
  case 'status': cmdStatus(flags); break;
  case 'list': cmdList(); break;
  case 'move': cmdMove(flags); break;
  case 'item': cmdItem(sub, positional, flags); break;
  case 'spec-ref': cmdSpecRef(sub, flags); break;
  case 'set': cmdSet(sub, flags); break;
  case 'accept': cmdAccept(flags).catch(console.error); break;
  case 'archive': cmdArchive(flags); break;
  case 'checkpoint': cmdCheckpoint(flags); break;
  case 'knowledge': cmdKnowledge(sub, flags); break;
  default: console.log('Usage: proposal.js <create|continue|status|list|move|item|spec-ref|set|accept|archive|checkpoint|knowledge>');
}
