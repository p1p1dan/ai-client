/**
 * Which `localStorage` writes carry an earlier release's repository list into
 * a store the new build has ALREADY created. Pure: no `electron`, no `fs`.
 *
 * `appStateMigration.migratePriorUserData` copies `Local Storage` whole when
 * the destination is absent — that is every v0.3.4 user on their first boot of
 * the new build. A machine that has already booted test.17+ has its own store,
 * and a whole-directory copy must not touch it (mixing leveldb files corrupts
 * it). Skipping it outright is not an option either: the conversation list is
 * drawn under the repository tree, so a conversation whose repository is
 * missing is as invisible as one that was never migrated. The unit here is
 * therefore the KEY, applied through Chromium itself
 * (`priorLocalStorageImport.ts`).
 *
 * Rules — "first writer wins", at key granularity:
 *  - `aiclient-repositories`: union by canonical path. Rows the new build
 *    already has stay exactly as they are; an old repository is appended only
 *    when no row names the same directory.
 *  - `aiclient-repository-groups`: union by `id`, so an appended repository
 *    keeps its group instead of having its `groupId` dropped on hydration.
 *  - every other key: written only when the new store does not have it.
 *  - a list the new store holds but that does not parse is left alone — the
 *    new build owns it, and guessing is how a user's list gets replaced.
 *
 * Earlier stores are given newest first; because the rules never overwrite,
 * that order is the precedence.
 */

import { canonicalPathKey } from '@shared/utils/path';

export const REPOSITORIES_STORAGE_KEY = 'aiclient-repositories';
export const REPOSITORY_GROUPS_STORAGE_KEY = 'aiclient-repository-groups';

export interface LocalStorageMergePlan {
  /** Keys to `setItem`, with their full new value. */
  writes: Record<string, string>;
  /** Keys that did not exist in the new store at all. */
  addedKeys: number;
  /** Repositories appended to an existing list. */
  addedRepositories: number;
  /** Groups appended to an existing list. */
  addedGroups: number;
}

type IdentityOf = (item: unknown) => string | null;

const repositoryIdentity: IdentityOf = (item) => {
  const path = (item as { path?: unknown } | null)?.path;
  return typeof path === 'string' && path.length > 0 ? canonicalPathKey(path) : null;
};

const groupIdentity: IdentityOf = (item) => {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const UNION_KEYS = new Map<string, IdentityOf>([
  [REPOSITORIES_STORAGE_KEY, repositoryIdentity],
  [REPOSITORY_GROUPS_STORAGE_KEY, groupIdentity],
]);

function parseArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `current` extended by the items of `prior` it does not already name; `null` when nothing is added. */
function unionByIdentity(
  current: string,
  prior: string,
  identityOf: IdentityOf
): { value: string; added: number } | null {
  const currentItems = parseArray(current);
  const priorItems = parseArray(prior);
  if (!currentItems || !priorItems) return null;
  const known = new Set(currentItems.map(identityOf).filter((key) => key !== null));
  const appended: unknown[] = [];
  for (const item of priorItems) {
    const key = identityOf(item);
    if (key === null || known.has(key)) continue;
    known.add(key);
    appended.push(item);
  }
  if (appended.length === 0) return null;
  return { value: JSON.stringify([...currentItems, ...appended]), added: appended.length };
}

export function planLocalStorageMerge(
  current: Record<string, string>,
  priors: Record<string, string>[]
): LocalStorageMergePlan {
  const writes = new Map<string, string>();
  const plan: LocalStorageMergePlan = {
    writes: {},
    addedKeys: 0,
    addedRepositories: 0,
    addedGroups: 0,
  };
  const currentValueOf = (key: string): string | undefined =>
    writes.has(key) ? writes.get(key) : Object.hasOwn(current, key) ? current[key] : undefined;

  for (const prior of priors) {
    for (const [key, priorValue] of Object.entries(prior)) {
      const existing = currentValueOf(key);
      if (existing === undefined) {
        writes.set(key, priorValue);
        plan.addedKeys += 1;
        continue;
      }
      const identityOf = UNION_KEYS.get(key);
      if (!identityOf) continue;
      const union = unionByIdentity(existing, priorValue, identityOf);
      if (!union) continue;
      writes.set(key, union.value);
      if (key === REPOSITORIES_STORAGE_KEY) plan.addedRepositories += union.added;
      else plan.addedGroups += union.added;
    }
  }
  plan.writes = Object.fromEntries(writes);
  return plan;
}
