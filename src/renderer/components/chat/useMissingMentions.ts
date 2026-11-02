import { isRemoteVirtualPath } from '@shared/utils/remotePath';
import { useEffect, useRef, useState } from 'react';

/**
 * PiLab R2 (user ruling 2026-10-30): which of the draft's `@` references name
 * nothing on disk, so their chips can say 「找不到」 before the message goes.
 * The text is sent as typed either way; this only tells the user.
 *
 * Checked a moment after typing stops. A reference that exists is remembered
 * for the composer's life; one that does not is checked again on the next
 * change (the user may be about to create it). A path that cannot be checked
 * here (`~`, no folder) is never called missing.
 */

const CHECK_DELAY_MS = 300;

/** The absolute path a mention names, in the separator style of `cwd`; null when unknown. */
export function mentionTarget(cwd: string, mention: string): string | null {
  if (mention.startsWith('~')) return null;
  if (mention.startsWith('/') || /^[A-Za-z]:[\\/]/.test(mention)) return mention;
  const windows = !isRemoteVirtualPath(cwd) && cwd.includes('\\') && !cwd.includes('/');
  const sep = windows ? '\\' : '/';
  const rel = mention.replace(/^\.[\\/]/, '').replace(/[\\/]+$/, '');
  const relNative = windows ? rel.replace(/\//g, '\\') : rel.replace(/\\/g, '/');
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${relNative}`;
}

function splitParent(target: string): { parent: string; name: string } | null {
  const at = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  if (at < 0 || at === target.length - 1) return null;
  const head = target.slice(0, at);
  // `/x` → `/`; `C:\x` → `C:\`.
  const parent = head === '' || /^[A-Za-z]:$/.test(head) ? target.slice(0, at + 1) : head;
  return { parent, name: target.slice(at + 1) };
}

/**
 * Whether `dir` is a folder, walking down from the chat's folder (which is
 * there) and listing only folders already known to be: a missing reference
 * never makes Main fail a read, which it would log as an error.
 */
async function dirExists(dir: string, cwd: string, known: Map<string, boolean>): Promise<boolean> {
  if (cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}\\`)) return true;
  const cached = known.get(dir);
  if (cached !== undefined) return cached;
  const split = splitParent(dir);
  let found = split === null; // a root
  if (split && (await dirExists(split.parent, cwd, known))) {
    try {
      const entries = await window.electronAPI.file.list(split.parent);
      found = entries.some((entry) => entry.name === split.name && entry.isDirectory);
    } catch {
      found = false;
    }
  }
  if (found) known.set(dir, true);
  return found;
}

/** A file, or a folder (`file.exists` answers for files only). */
async function referenceExists(
  target: string,
  cwd: string,
  known: Map<string, boolean>
): Promise<boolean> {
  if (await window.electronAPI.file.exists(target)) return true;
  return dirExists(target, cwd, known);
}

export function useMissingMentions(paths: readonly string[], cwd: string | null): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const known = useRef(new Set<string>());
  const folders = useRef(new Map<string, boolean>());
  const key = paths.join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `paths`.
  useEffect(() => {
    if (!cwd || paths.length === 0) {
      setMissing((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void Promise.all(
        paths.map(async (path) => {
          const target = mentionTarget(cwd, path);
          if (!target || known.current.has(target)) return null;
          try {
            if (await referenceExists(target, cwd, folders.current)) {
              known.current.add(target);
              return null;
            }
            return path;
          } catch {
            return null; // could not ask: say nothing
          }
        })
      ).then((results) => {
        if (!current) return;
        setMissing(new Set(results.filter((path): path is string => path !== null)));
      });
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, cwd]);

  return missing;
}
