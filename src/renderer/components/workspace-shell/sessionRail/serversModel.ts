/**
 * The session rail's Servers card (user, 2026-10-22): the local addresses the
 * conversation's running background commands announced. A dev server prints
 * one (`Local:   http://localhost:5173/`, `listening on http://0.0.0.0:3000`);
 * nothing else in the app knows which ports a session opened, so the card reads
 * them from the job's own output.
 */

/** One local address a running job announced. */
export interface ServerRow {
  /** `jobId:port`, stable while the job runs. */
  key: string;
  jobId: string;
  /** What to open: `0.0.0.0` / `[::]` read as `localhost`. */
  url: string;
  port: number;
  /** The job's command, for the row's second line. */
  label: string;
}

// CSI and OSC sequences: dev servers colour their banners.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))(?:\/[^\s'"<>`)\]]*)?/gi;

/**
 * The local addresses in `text`, one per port (the last one printed wins), in
 * the order the ports first appeared. Trailing sentence punctuation is not part
 * of an address.
 */
export function detectLocalServerUrls(text: string): Array<{ url: string; port: number }> {
  const byPort = new Map<number, string>();
  for (const match of text.replace(ANSI_RE, '').matchAll(LOCAL_URL_RE)) {
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const url = match[0]
      .replace(/[.,;:!?]+$/, '')
      .replace(/\/\/(?:0\.0\.0\.0|\[::\])(?=:)/, '//localhost');
    byPort.set(port, url);
  }
  return [...byPort].map(([port, url]) => ({ url, port }));
}

/**
 * How much of a read's tail is carried into the next one, so an address split
 * across two reads is still seen whole.
 */
export const SERVER_SCAN_CARRY = 256;

/** The rows for the jobs still running, in job order. */
export function deriveServerRows(
  jobs: ReadonlyArray<{ id: string; label: string; status: string }>,
  found: ReadonlyMap<string, ReadonlyArray<{ url: string; port: number }>>
): ServerRow[] {
  return jobs.flatMap((job) =>
    job.status === 'running'
      ? (found.get(job.id) ?? []).map(({ url, port }) => ({
          key: `${job.id}:${port}`,
          jobId: job.id,
          url,
          port,
          label: job.label,
        }))
      : []
  );
}
