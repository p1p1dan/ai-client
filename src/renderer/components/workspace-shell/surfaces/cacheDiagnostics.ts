/**
 * Issue #9 (decision 173 §4.5): the text the Run panel's 「复制诊断信息」 puts
 * on the clipboard, for a gateway administrator to match against the
 * gateway's own logs (prototype README §7).
 *
 * Numbers, clock times, the app version, the model and effort, and the
 * gateway session id the host names in `metadata.user_id` (decision 173 §4.1):
 * nothing else. No prompt, tool content, path, account or gateway address
 * ever enters it — the inputs below carry none.
 *
 * Pure, so the layout is pinned by the node-env vitest; the caller passes the
 * translator.
 */

import { englishTranslate, type Translate } from '@shared/i18n';
import type { PiUsageCacheSession } from '@shared/piUsage';
import { formatExactTokens, type RunCachePrefixCheck, type RunCacheRow } from './runPanelModel';

export interface CacheDiagnosticsInput {
  appVersion: string | null;
  /** `process.platform`, as preload reports it. */
  platform: string | null;
  model: string | null;
  /** The effort id the chat sends (`max`, `high`, …), or `default`. */
  effort: string | null;
  /** Steps the session settled in all (`PiSessionUsage.turns`), when known. */
  sessionSteps: number | null;
  /** The latest session totals the host sent (`PiUsageCacheStep.session`). */
  session: PiUsageCacheSession | null;
  prefix: RunCachePrefixCheck;
  /** The listed turns, oldest first (`cacheTurnsOf`). */
  turns: readonly { turn: number; rows: readonly RunCacheRow[] }[];
}

const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
};

const pad2 = (value: number) => String(value).padStart(2, '0');

/** `14:05:29`, local time. */
export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `2026-10-10 14:05:12 UTC+08:00`, local time with its offset, so other logs can be lined up. */
export function formatDiagnosticDateTime(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClockTime(ms)} UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/** Columns a monospace font gives the text: CJK and full-width forms take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

const padStart = (text: string, width: number) =>
  ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
const padEnd = (text: string, width: number) =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));

function prefixLine(prefix: RunCachePrefixCheck, t: Translate): string {
  if (prefix === 'verified') {
    return t('Prefix check: every request with no local cause extended the request before it');
  }
  if (prefix === 'diverged') {
    return t(
      'Prefix check: some requests did not extend the request before them (see the verdicts)'
    );
  }
  return t('Prefix check: not recorded');
}

function turnLine(turn: number, rows: readonly RunCacheRow[], t: Translate): string {
  const first = rows[0];
  if (!first || first.at === null) return t('Turn {{turn}}', { turn });
  const time = formatDiagnosticDateTime(first.at);
  return first.step === 1
    ? t('Turn {{turn}} started at {{time}}', { turn, time })
    : t('Turn {{turn}}, listed from step {{step}}, at {{time}}', { turn, step: first.step, time });
}

/** One turn's table: step, time, prompt, read, write, verdict, aligned for a monospace font. */
function turnTable(rows: readonly RunCacheRow[], t: Translate): string[] {
  const header = [t('Step'), t('Time'), t('Prompt'), t('Reused'), t('Written'), t('Verdict')];
  const cells = rows.map((row) => [
    String(row.step),
    row.at === null ? '--:--:--' : formatClockTime(row.at),
    String(row.prompt),
    String(row.read),
    String(row.write),
    row.verdict,
  ]);
  const widthOf = (column: number, minimum: number) =>
    Math.max(minimum, ...[header, ...cells].map((line) => displayWidth(line[column] ?? '')));
  const widths = [widthOf(0, 3), widthOf(1, 8), widthOf(2, 8), widthOf(3, 8), widthOf(4, 8)];
  const line = (values: string[]) =>
    [
      padStart(values[0] ?? '', widths[0] ?? 0),
      padEnd(values[1] ?? '', widths[1] ?? 0),
      padStart(values[2] ?? '', widths[2] ?? 0),
      padStart(values[3] ?? '', widths[3] ?? 0),
      padStart(values[4] ?? '', widths[4] ?? 0),
      values[5] ?? '',
    ]
      .join('  ')
      .trimEnd();
  return [line(header), ...cells.map(line)];
}

export function buildCacheDiagnostics(
  input: CacheDiagnosticsInput,
  t: Translate = englishTranslate
): string {
  const lines = [
    t('PiLab Ai cache diagnostics (numbers and the gateway session ID only)'),
    t('Version: {{version}} · {{platform}}', {
      version: input.appVersion || '?',
      platform: (input.platform && PLATFORM_NAMES[input.platform]) || input.platform || '?',
    }),
  ];
  const gatewaySession = input.session?.gatewaySession;
  if (gatewaySession) lines.push(t('Gateway session ID: {{id}}', { id: gatewaySession }));
  lines.push(
    t('Model: {{model}} · effort {{effort}}', {
      model: input.model || '?',
      effort: input.effort || '?',
    })
  );
  if (input.session) {
    const listed = input.turns.reduce((sum, turn) => sum + turn.rows.length, 0);
    lines.push(
      t(
        'This chat: {{steps}} steps, {{unexplained}} with no local cause ({{rebuilds}} rebuilds), about {{tokens}} tokens written again',
        {
          steps: input.sessionSteps ?? listed,
          unexplained: input.session.unexplained,
          rebuilds: input.session.unexplainedRebuilds,
          tokens: formatExactTokens(input.session.unexplainedRewriteTokens),
        }
      )
    );
  }
  lines.push(prefixLine(input.prefix, t));
  for (const { turn, rows } of input.turns) {
    if (rows.length === 0) continue;
    lines.push('', turnLine(turn, rows, t), '', ...turnTable(rows, t));
  }
  return lines.join('\n');
}
