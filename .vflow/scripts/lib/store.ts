// store.ts — All IO: proposal CRUD, state.json CRUD, ledger.md read/parse, repo index, item helpers.

import {
  existsSync, mkdirSync, writeFileSync, renameSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PROPOSALS_DIR, REPO_INDEX_PATH, isoNow, todayCompact, readJson, readText,
} from './config.js';
import type {
  Proposal, RepoIndex, RepoIndexEntry, StateFile, StateItem, ItemStatus,
} from './schema.js';

// --- ID generation ---

export function nextProposalId(): string {
  const today = todayCompact();
  const prefix = `P-${today}-`;
  const index = readRepoIndex();
  let max = 0;
  for (const entry of index.proposals) {
    if (entry.id.startsWith(prefix)) {
      const n = parseInt(entry.id.slice(prefix.length), 10);
      if (n > max) max = n;
    }
  }
  // Also scan directory for IDs not yet in index
  if (existsSync(PROPOSALS_DIR)) {
    for (const name of readdirSync(PROPOSALS_DIR)) {
      if (name.startsWith(prefix)) {
        const seg = name.slice(prefix.length).split('-')[0];
        const n = parseInt(seg, 10);
        if (n > max) max = n;
      }
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export function proposalDir(id: string, slug: string): string {
  return join(PROPOSALS_DIR, `${id}-${slug}`);
}

export function findProposalDir(id: string): string | null {
  if (!existsSync(PROPOSALS_DIR)) return null;
  for (const name of readdirSync(PROPOSALS_DIR)) {
    if (name.startsWith(id)) {
      return join(PROPOSALS_DIR, name);
    }
  }
  return null;
}

// --- Atomic write helper ---

function atomicWrite(path: string, data: string): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, path);
}

// --- Proposal ---

export function readProposal(dir: string): Proposal | null {
  return readJson<Proposal>(join(dir, 'proposal.json'));
}

export function writeProposal(dir: string, proposal: Proposal): void {
  proposal.updated_at = isoNow();
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n');
}

// --- State (T2/T3 only; every field participates in a gate, so this is the only
// I/O surface — the CLI is the sole writer, never AI Write/Edit) ---

export function readState(dir: string): StateFile | null {
  return readJson<StateFile>(join(dir, 'state.json'));
}

export function writeState(dir: string, state: StateFile): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

// --- Ledger (T2/T3 only; CLI only writes the initial header — every transition/
// checkpoint entry after that is hand-written by the AI via Write/Edit) ---

export function initLedger(dir: string, id: string, title: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.md'), `# Ledger: ${title} (${id})\n`, 'utf-8');
}

export function readLedgerText(dir: string): string {
  return readText(join(dir, 'ledger.md'));
}

export interface LedgerTransitionEntry {
  ts: string;
  from: string;
  to: string;
  satisfied: string;
}

const TRANSITION_HEADING = /^## \[(.+?)\] (\S+) -> (\S+)$/;

// Parses every "## [ts] from -> to" heading (transitions, including self-loops
// like "decide -> decide") plus its "- Satisfied:" line. CHECKPOINT headings
// don't match this shape and are ignored here.
export function parseLedgerTransitions(dir: string): LedgerTransitionEntry[] {
  const lines = readLedgerText(dir).split('\n');
  const entries: LedgerTransitionEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TRANSITION_HEADING.exec(lines[i].trim());
    if (!m) continue;
    let satisfied = '';
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) {
      const sm = /^- Satisfied:\s*(.*)$/.exec(lines[j].trim());
      if (sm) { satisfied = sm[1]; break; }
    }
    entries.push({ ts: m[1], from: m[2], to: m[3], satisfied });
  }
  return entries;
}

export function lastLedgerTransition(dir: string): LedgerTransitionEntry | null {
  const entries = parseLedgerTransitions(dir);
  return entries.length ? entries[entries.length - 1] : null;
}

export function lastDecideRelatedTransition(dir: string): LedgerTransitionEntry | null {
  const entries = parseLedgerTransitions(dir);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].from === 'decide' || entries[i].to === 'decide') return entries[i];
  }
  return null;
}

// --- Repo Index ---

export function readRepoIndex(): RepoIndex {
  return readJson<RepoIndex>(REPO_INDEX_PATH) ?? { schema_version: 1, proposals: [] };
}

export function writeRepoIndex(index: RepoIndex): void {
  atomicWrite(REPO_INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
}

export function upsertRepoIndex(entry: RepoIndexEntry): void {
  const index = readRepoIndex();
  const idx = index.proposals.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    index.proposals[idx] = entry;
  } else {
    index.proposals.push(entry);
  }
  writeRepoIndex(index);
}

export function removeFromIndex(id: string): void {
  const index = readRepoIndex();
  index.proposals = index.proposals.filter(e => e.id !== id);
  writeRepoIndex(index);
}

// --- State item helpers (serial "one doing at a time" invariant; no DAG) ---

export function activeItem(state: StateFile): StateItem | null {
  return state.items.find(i => i.status === 'doing') ?? null;
}

export function findItem(state: StateFile, itemId: string): StateItem | null {
  return state.items.find(i => i.id === itemId) ?? null;
}

export function setItemStatus(state: StateFile, itemId: string, status: ItemStatus): StateItem | null {
  const item = state.items.find(i => i.id === itemId);
  if (item) item.status = status;
  return item ?? null;
}
