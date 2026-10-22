import type { DshJobSummary } from '@shared/types/runtimeEvents';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveServerRows,
  detectLocalServerUrls,
  SERVER_SCAN_CARRY,
  type ServerRow,
} from './serversModel';

const POLL_MS = 3_000;
const READ_MAX_BYTES = 64 * 1024;

interface JobScan {
  next: number;
  carry: string;
  urls: Array<{ url: string; port: number }>;
}

/**
 * Reads the running jobs' output from where it left off, every few seconds
 * while the card is mounted, and keeps the local addresses each announced.
 * Nothing runs while no job does.
 */
export function useJobServers(
  sessionId: string,
  jobs: readonly DshJobSummary[] | undefined,
  live: boolean
): ServerRow[] {
  const scans = useRef(new Map<string, JobScan>());
  const [found, setFound] = useState<ReadonlyMap<string, JobScan['urls']>>(new Map());

  const runningIds = live
    ? (jobs ?? [])
        .filter((job) => job.status === 'running')
        .map((job) => job.id)
        .join('\n')
    : '';

  useEffect(() => {
    const read = window.electronAPI?.chat?.readSessionJob;
    if (!runningIds || !read) return;
    const ids = runningIds.split('\n');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = async () => {
      let changed = false;
      for (const jobId of ids) {
        // Job ids (`bash-3`) repeat across sessions: keyed by both.
        const key = `${sessionId}\n${jobId}`;
        const prev = scans.current.get(key) ?? { next: 0, carry: '', urls: [] };
        try {
          const result = await read({
            sessionId,
            jobId,
            from: prev.next,
            maxBytes: READ_MAX_BYTES,
          });
          if (cancelled) return;
          if (!result || result.next === prev.next) continue;
          const text = prev.carry + result.text;
          const seen = detectLocalServerUrls(text);
          const merged = new Map(prev.urls.map((entry) => [entry.port, entry.url]));
          for (const { url, port } of seen) merged.set(port, url);
          const urls = [...merged].map(([port, url]) => ({ url, port }));
          scans.current.set(key, {
            next: result.next,
            carry: text.slice(-SERVER_SCAN_CARRY),
            urls,
          });
          if (
            urls.length !== prev.urls.length ||
            urls.some((u, i) => u.url !== prev.urls[i]?.url)
          ) {
            changed = true;
          }
        } catch {
          // A read that fails (the slot went away) is retried on the next tick.
        }
      }
      if (cancelled) return;
      if (changed) {
        setFound(new Map([...scans.current].map(([key, entry]) => [key, entry.urls])));
      }
      timer = setTimeout(() => void scan(), POLL_MS);
    };
    void scan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, runningIds]);

  return useMemo(() => {
    if (!live) return [];
    const prefix = `${sessionId}\n`;
    const mine = new Map(
      [...found]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, urls]) => [key.slice(prefix.length), urls])
    );
    return deriveServerRows(jobs ?? [], mine);
  }, [sessionId, live, jobs, found]);
}
