/**
 * The `environment` slot: where the session runs.
 *
 * Field bug (Windows, workspace `F:\tmp`): nothing in the system prompt named
 * the working directory, so a model handed `@notes.md` went looking under `C:\`
 * before it found the file. The pi-coding-agent prompt this runtime replaced
 * ended with `Current working directory: <cwd>`; this restores that fact, plus
 * the ones the tools make true here: what relative paths resolve against, what
 * an `@path` token in a user message means, and which shell `bash` really is.
 *
 * Every value is resolved once per graph by `bootstrap.ts` — the date included —
 * so the text is fixed for the session and the slot can honestly sit in the
 * `session` band (see `segments.ts`).
 */

import type { PromptSegment } from './segments.ts';

export interface PromptEnvironment {
  /** The tools workspace (canonical): the directory relative tool paths resolve against. */
  root: string;
  platform: NodeJS.Platform;
  /** The bash tool's executable; absent when the session registered no bash tool. */
  shellPath?: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
}

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/** Local calendar date as `YYYY-MM-DD`; no time, so it cannot change within a day. */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The slot's text.
 *
 * `bash: false` drops the shell facts for a caller without the tool (a
 * delegate whose definition does not declare it). The shell is only named
 * when `shellPath` is set, which is exactly when `plugins/tools/index.ts`
 * registers `bash` (windows-04).
 */
export function environmentText(
  facts: PromptEnvironment,
  options: { bash?: boolean } = {}
): string {
  const bash = Boolean(facts.shellPath) && options.bash !== false;
  const sentences = [
    `Environment: the working directory is ${facts.root}.`,
    `Relative paths in tool calls resolve against it${bash ? ', and each bash command starts there' : ''}.`,
    'In a user message, @path (for example @docs/notes.md) refers to that file relative to the working directory.',
    `Platform: ${PLATFORM_NAMES[facts.platform] ?? facts.platform}.`,
  ];
  if (bash) sentences.push(shellSentence(facts));
  sentences.push(`Current date: ${facts.date} (taken when this session started).`);
  return sentences.join(' ');
}

export function environmentSegment(facts: PromptEnvironment): PromptSegment {
  return { slot: 'environment', text: environmentText(facts) };
}

/**
 * `host/shell.ts` never picks the WSL launcher on Windows, so there it is a
 * native MSYS bash (Git Bash): POSIX syntax, and an unquoted backslash path is
 * an escape sequence rather than a path.
 */
function shellSentence(facts: PromptEnvironment): string {
  if (facts.platform !== 'win32') return `The bash tool runs ${facts.shellPath}.`;
  const forward = facts.root.replaceAll('\\', '/');
  return `The bash tool runs ${facts.shellPath} (Git Bash), not cmd or PowerShell: use POSIX shell syntax, and write Windows paths with forward slashes (${forward}) or quote them.`;
}
