// schema.ts — Pure types and enums for the vflow v3 proposal system.

export const POINTERS = ['understand', 'decide', 'build', 'check', 'done'] as const;
export type Pointer = typeof POINTERS[number];

export const LIFECYCLE = [
  'active', 'blocked', 'on_hold', 'done', 'archived', 'cancelled',
] as const;
export type LifecycleStatus = typeof LIFECYCLE[number];

export const PROPOSAL_TYPES = ['bug', 'feature', 'refactor', 'reference_build'] as const;
export type ProposalType = typeof PROPOSAL_TYPES[number];

export const TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type Tier = typeof TIERS[number];

export const ITEM_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const;
export type ItemStatus = typeof ITEM_STATUSES[number];

export interface Blocking {
  status: 'blocked' | 'none';
  type?: string;
  reason?: string;
  since?: string;
}

export interface Workspace {
  isolate_intent: boolean;
  branch: string | null;
}

export interface Proposal {
  id: string;
  title: string;
  slug: string;
  lifecycle_status: LifecycleStatus;
  blocking: Blocking;
  tier: Tier;
  type: ProposalType;
  workspace?: Workspace;
  created_at: string;
  updated_at: string;
  summary?: string;
  knowledge_processed?: boolean;
  accepted_at?: string;
  accepted_by?: string;
  accepted_source?: 'user_terminal' | 'ai_relay';
  schema_version: 2;
}

export interface StateItem {
  id: string;
  title: string;
  status: ItemStatus;
  note?: string;
}

export interface SpecRef {
  file: string;
  reason: string;
}

export interface StateFile {
  schema_version: 2;
  pointer: Pointer;
  history_stack: Pointer[];
  scope: string;
  items: StateItem[];
  spec_refs: SpecRef[];
}

export interface SessionRuntime {
  session_id: string;
  active_proposal_id: string | null;
  active_execution_item_id: string | null;
  pending_user_confirmation: boolean;
  pointer_stall_count?: number;
  last_seen_pointer?: string;
  last_seen_at: string;
}

export interface RepoIndexEntry {
  id: string;
  slug: string;
  dir: string;
  title: string;
  lifecycle_status: LifecycleStatus;
  type: ProposalType;
  updated_at: string;
}

export interface RepoIndex {
  schema_version: 1;
  proposals: RepoIndexEntry[];
}
