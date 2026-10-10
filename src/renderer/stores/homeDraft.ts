import { canonicalPathKey } from '@shared/utils/path';
import { create } from 'zustand';
import { useChatSessionsStore } from './chatSessions';

/**
 * dsh-rebase decision 174 (GitHub issue #6, second wave): the home page's
 * draft target — where the NEXT conversation will be made, picked on the
 * composer's work bar while no conversation is open.
 *
 * The home page is "no conversation open" (`activeSessionId === null`, user
 * ruling 2026-10-10), so there is no session row to retarget while the user
 * picks. Picking only writes here; the conversation is made by the send that
 * uses it (`ChatComposer`'s home send), on this target, and only then.
 *
 * Memory only, for the run: the default (the most recently active repository)
 * is recomputed whenever nothing has been picked.
 *
 * Targets are kept by PATH, not by workspace id: a repository just added from
 * the home page has no workspace until the tree sync derives one, and a path
 * picked before that resolves the moment it lands (`resolveHomeTarget`).
 */
export type HomeTargetPick =
  /** Nothing picked: the most recently active repository. */
  | { kind: 'default' }
  /** 「不选仓库（临时对话）」: a temporary chat in a private directory. */
  | { kind: 'unbound' }
  /** A repository (its default checkout) by the workspace's path. */
  | { kind: 'path'; path: string };

/**
 * The branch this conversation should start on (user ruling 2026-10-10: on the
 * home page a branch pick is switched to at SEND time, not when picked).
 */
export interface HomeDraftBranch {
  /** The checkout the branch was picked in; the draft applies to it only. */
  workdir: string;
  name: string;
  /** Picked through 「创建新分支...」: created (and checked out) at send time. */
  create: boolean;
}

interface HomeDraftState {
  pick: HomeTargetPick;
  branch: HomeDraftBranch | null;
  /** A new target drops the branch picked for the old one. */
  setPick: (pick: HomeTargetPick) => void;
  setBranch: (branch: HomeDraftBranch | null) => void;
}

function samePick(a: HomeTargetPick, b: HomeTargetPick): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'path' && b.kind === 'path') {
    return canonicalPathKey(a.path) === canonicalPathKey(b.path);
  }
  return true;
}

export const DEFAULT_HOME_PICK: HomeTargetPick = { kind: 'default' };

export const useHomeDraftStore = create<HomeDraftState>()((set, get) => ({
  pick: DEFAULT_HOME_PICK,
  branch: null,
  setPick: (pick) => {
    if (samePick(get().pick, pick)) return;
    set({ pick, branch: null });
  },
  setBranch: (branch) => set({ branch }),
}));

/**
 * Open the home page: no conversation on screen. Running conversations are
 * not touched — they stay in 「正在活动」 and one click brings them back.
 *
 * `preselect` is what the entry asks for: a folder's 「＋」 its repository, a
 * conversation's 「＋」 the conversation's own, 「新建临时对话」 no repository.
 * Without it the home page keeps whatever the user last picked there.
 */
export function openHome(preselect?: HomeTargetPick): void {
  if (preselect) useHomeDraftStore.getState().setPick(preselect);
  useChatSessionsStore.getState().selectSession(null);
}

/**
 * A repository was just added (or an already-added one picked again in the
 * add dialog). On the home page it becomes the draft target, so the title and
 * the work bar name it at once (user ruling 2026-10-10). Anywhere else the
 * home page's pick is left alone.
 */
export function preselectAddedRepository(path: string): void {
  if (useChatSessionsStore.getState().activeSessionId !== null) return;
  useHomeDraftStore.getState().setPick({ kind: 'path', path });
}

/** Test-only: module state must not leak between cases. */
export function resetHomeDraftForTests(): void {
  useHomeDraftStore.setState({ pick: DEFAULT_HOME_PICK, branch: null });
}
