/**
 * Route B S-5 (docs/plantree/plans/claude-sdk-engine/topics/s5-regression.md R-3): the
 * runtime events of one probe scenario, reduced to what does not change from run to run,
 * so `event-record.ts` can diff them against a committed sample. Pure.
 *
 * - Ids (messages, blocks, tool calls, permissions, questions, attempts) become `<kind#n>`
 *   by first appearance.
 * - The run's directories become `<ws>`, `<config>` and `<tmp>`, in Windows, forward-slash
 *   and Git Bash (`/tmp/...`, `/c/...`) spellings; the OS name `uname` prints becomes `<os>`.
 * - Consecutive deltas of one block are joined; a repeated status or tool update keeps its
 *   last; `usage.updated` leaves the sequence (its count and numbers follow the stream's
 *   pacing) and only its keys are kept.
 */

export interface RawEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface RawRecording {
  scenario: string;
  workspace: string;
  configDir: string;
  tmp: string;
  events: RawEvent[];
}

export interface NormalizedRecording {
  scenario: string;
  events: RawEvent[];
  usageKeys: string[];
}

/** Id shapes the host and the CLI mint, each with the label it is shown under. */
const ID_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/cc-question-toolu_[0-9A-Za-z]+/g, 'question'],
  [/toolu_[0-9A-Za-z]+/g, 'call'],
  [/cc-[0-9a-f]{8}-t\d+-s\d+(?:-[a-z]+\d*)?/g, 'msg'],
  [/cc-user-\d+(?:-text)?/g, 'user'],
  [/attempt-\d+/g, 'attempt'],
  [/send-probe-\d+/g, 'request'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid'],
];

/** The spellings of a directory a string may carry. */
function spellings(dir: string, tmp: string): string[] {
  const slashed = dir.replace(/\\/g, '/');
  const out = [dir, slashed];
  const tmpSlashed = tmp.replace(/\\/g, '/').replace(/\/+$/, '');
  // Git Bash shows the Windows temp directory as /tmp.
  if (slashed.toLowerCase().startsWith(`${tmpSlashed.toLowerCase()}/`)) {
    out.push(`/tmp${slashed.slice(tmpSlashed.length)}`);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * Any absolute spelling that ends in the directory's last two names (the run's own
 * `pilab-record-XXXXXX/ws`). Where Git Bash mounts /tmp depends on how TEMP is spelled
 * (CI runners use an 8.3 short path), so it may print the run's directory as /c/... or
 * under a /tmp further up instead of the spellings above.
 */
function anyPrefix(dir: string): RegExp | null {
  const names = dir.split(/[\\/]+/).filter(Boolean);
  if (names.length < 2) return null;
  const tail = names.slice(-2).map(escapeRegExp).join('[\\\\/]');
  const name = `[^\\s"'\\\\/<>]`;
  return new RegExp(`(?:[A-Za-z]:)?(?:[\\\\/]${name}+)*?[\\\\/]${tail}(?!${name})`, 'gi');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeRecording(raw: RawRecording): NormalizedRecording {
  const ids = new Map<string, string>();
  const counts = new Map<string, number>();
  const idFor = (value: string, kind: string) => {
    let id = ids.get(value);
    if (!id) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      id = `<${kind}#${n}>`;
      ids.set(value, id);
    }
    return id;
  };
  const fallback = (dir: string, label: string): Array<[RegExp, string]> => {
    const pattern = anyPrefix(dir);
    return pattern ? [[pattern, label]] : [];
  };
  const dirs: Array<[RegExp, string]> = [
    ...spellings(raw.workspace, raw.tmp).map(
      (s) => [new RegExp(escapeRegExp(s), 'gi'), '<ws>'] as [RegExp, string]
    ),
    ...fallback(raw.workspace, '<ws>'),
    ...spellings(raw.configDir, raw.tmp).map(
      (s) => [new RegExp(escapeRegExp(s), 'gi'), '<config>'] as [RegExp, string]
    ),
    ...fallback(raw.configDir, '<config>'),
    ...spellings(raw.tmp, raw.tmp).map(
      (s) => [new RegExp(escapeRegExp(s), 'gi'), '<tmp>'] as [RegExp, string]
    ),
  ];
  const text = (value: string): string => {
    let out = value;
    for (const [pattern, label] of dirs) out = out.replace(pattern, label);
    // After a directory token, a path continues in forward slashes on every platform.
    out = out.replace(
      /<(ws|config|tmp)>((?:\\[^\s"'\\]+)+)/g,
      (_, k, rest) => `<${k}>${rest.replace(/\\/g, '/')}`
    );
    out = out.replace(/\b(?:MINGW64_NT|MSYS_NT|CYGWIN_NT)[^\s]*|\bLinux\b|\bDarwin\b/g, '<os>');
    for (const [pattern, kind] of ID_PATTERNS) out = out.replace(pattern, (m) => idFor(m, kind));
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };

  const usageKeys = new Set<string>();
  const events: RawEvent[] = [];
  for (const event of raw.events) {
    if (event.type === 'usage.updated') {
      for (const key of Object.keys(event.payload ?? {})) usageKeys.add(key);
      continue;
    }
    const next = {
      type: event.type,
      payload: walk(event.payload ?? {}) as Record<string, unknown>,
    };
    const last = events.at(-1);
    const sameBlock =
      last &&
      last.type === next.type &&
      (next.type === 'message.delta' || next.type === 'thinking.delta') &&
      last.payload?.messageId === next.payload.messageId &&
      last.payload?.blockId === next.payload.blockId;
    if (sameBlock && last?.payload) {
      last.payload.text = `${String(last.payload.text ?? '')}${String(next.payload.text ?? '')}`;
      continue;
    }
    const repeated =
      last &&
      last.type === next.type &&
      ((next.type === 'session.status' &&
        JSON.stringify(last.payload) === JSON.stringify(next.payload)) ||
        (next.type === 'tool.updated' && last.payload?.toolCallId === next.payload.toolCallId));
    if (repeated) {
      events[events.length - 1] = next;
      continue;
    }
    events.push(next);
  }
  return { scenario: raw.scenario, events, usageKeys: [...usageKeys].sort() };
}
