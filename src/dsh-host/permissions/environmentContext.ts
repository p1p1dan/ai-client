/**
 * `aiclient:environment` — the machine and workspace a session runs in, told
 * to the model (GitHub issue #2, decision 164).
 *
 * Some providers wrap every request in a default prompt of their own whose
 * environment section describes another machine (another OS, shell, working
 * directory and home). DSH's own runtime contexts state none of these facts,
 * so this one does, and says they win over any other description.
 *
 * Paths never enter the text itself: DSH interpolates `{{name}}` in context
 * text and throws on an unknown or malformed reference, so the session cwd
 * and the home directory are prompt variables (`aiclient_cwd`,
 * `aiclient_home`), substituted verbatim and not scanned again.
 *
 * The text depends on the session and the local date only, so DSH appends a
 * new runtime-context snapshot about once a day per active session (it appends
 * one only when the rendered text changed).
 */

import {
  arch as osArch,
  homedir as osHomedir,
  release as osRelease,
  version as osVersion,
} from 'node:os';
import type { DshAgentView } from './dshTypes.ts';

/** The context's name in DSH's prompt registry. */
export const ENVIRONMENT_PROMPT_CONTEXT = 'aiclient:environment';

/**
 * Where it sits among DSH's runtime contexts: `ENVIRONMENT_PROMPT_CONTEXT_GAP`
 * before `sandbox:policy` (110), first, since the policies are about this
 * environment.
 */
export const ENVIRONMENT_PROMPT_CONTEXT_BEFORE = 'SANDBOX_POLICY';
export const ENVIRONMENT_PROMPT_CONTEXT_GAP = 10;

/** Prompt variable: the calling session's header cwd. */
export const ENVIRONMENT_CWD_VARIABLE = 'aiclient_cwd';
/** Prompt variable: the host's home directory. */
export const ENVIRONMENT_HOME_VARIABLE = 'aiclient_home';

/** What the text is built from; injectable for tests. */
export interface EnvironmentFacts {
  platform: NodeJS.Platform;
  /** `os.release()`: the kernel version (`10.0.26100` on Windows 11). */
  release: string;
  /** `os.version()`: the edition on Windows (`Windows 11 Pro`). */
  version: string;
  arch: string;
  /** `os.homedir()`; empty when it cannot be read. */
  homedir: string;
  /** Read for every assembly. */
  now(): Date;
  /** The host's IANA time zone, read for every assembly; undefined when unknown. */
  timeZone(): string | undefined;
}

function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}

/** The host's facts: the static ones read once, the date and zone on every call. */
export function hostEnvironmentFacts(): EnvironmentFacts {
  return {
    platform: process.platform,
    release: safely(osRelease),
    version: safely(osVersion),
    arch: osArch(),
    homedir: safely(osHomedir),
    now: () => new Date(),
    timeZone: () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** OS-reported text never carries a `{{` that DSH would read as a variable reference. */
function plain(text: string): string {
  return text.replace(/[{}]/g, '').trim();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function offsetText(minutesEast: number): string {
  const sign = minutesEast < 0 ? '-' : '+';
  const minutes = Math.abs(minutesEast);
  return `UTC${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** `2026-10-09 (time zone Asia/Shanghai, UTC+08:00)`: the local date, never the time of day. */
export function localDateText(now: Date, timeZone: string | undefined): string {
  if (timeZone) {
    try {
      const day = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        day.find((entry) => entry.type === type)?.value ?? '';
      const zoneName =
        new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
          .formatToParts(now)
          .find((entry) => entry.type === 'timeZoneName')?.value ?? '';
      const offset = zoneName === 'GMT' ? 'UTC+00:00' : zoneName.replace(/^GMT/, 'UTC');
      return `${part('year')}-${part('month')}-${part('day')} (time zone ${plain(timeZone)}${offset ? `, ${offset}` : ''})`;
    } catch {
      // An unknown zone name: fall back to the process's local time.
    }
  }
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date} (${offsetText(-now.getTimezoneOffset())})`;
}

function operatingSystemLine(facts: EnvironmentFacts): string {
  const release = plain(facts.release);
  const platform = [facts.platform, plain(facts.arch)].filter(Boolean).join(', ');
  const kernel = (name: string) => [name, release].filter(Boolean).join(' ');
  switch (facts.platform) {
    case 'win32':
      // os.version() names the edition; os.release() 10.0.x alone reads like Windows 10.
      return `${plain(facts.version) || 'Windows'} (${[release, platform].filter(Boolean).join(', ')}). Use Windows paths with a drive letter, such as C:\\...; a POSIX path such as /Users/... or /home/... is not a valid path or working directory here.`;
    case 'darwin':
      return `macOS (${kernel('Darwin')}, ${platform}). Use POSIX paths.`;
    case 'linux':
      return `${kernel('Linux')} (${platform}). Use POSIX paths, such as /home/...; a Windows path such as C:\\... is not a valid path here.`;
    default:
      return `${kernel(facts.platform)} (${platform}). Use POSIX paths.`;
  }
}

/** The shell tool DSH mounts here: `pwsh` on Windows, `bash` elsewhere (dsh-base). */
function shellLine(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '`pwsh` (PowerShell); write commands in PowerShell syntax. There is no bash tool in this session.'
    : '`bash`.';
}

/**
 * The context for the agent a prompt is assembled for; empty without one.
 * The working directory line is there only when the agent's session header
 * has a cwd, the home line only when the home is known, so every variable the
 * text references has a value in the same assembly.
 */
export function environmentPromptText(
  facts: EnvironmentFacts,
  agent: DshAgentView | undefined
): string {
  if (!agent) return '';
  const cwd = agent.session?.header?.cwd;
  const lines = [
    'Environment of this session (authoritative, reported by the host):',
    `- Operating system: ${operatingSystemLine(facts)}`,
    `- Shell tool: ${shellLine(facts.platform)}`,
  ];
  if (cwd)
    lines.push(
      `- Working directory (the session workspace; relative paths, and shell commands without \`workdir\`, resolve against it): {{${ENVIRONMENT_CWD_VARIABLE}}}`
    );
  if (facts.homedir) lines.push(`- Home directory: {{${ENVIRONMENT_HOME_VARIABLE}}}`);
  lines.push(
    `- Today's date: ${localDateText(facts.now(), facts.timeZone())}`,
    'If any other part of the prompt describes a different environment (operating system, shell, working directory, user or home directory), it does not apply to this session: rely on the facts above.',
    'If a tool call fails with "unknown tool", that tool does not exist in this session; do not retry it under another name or casing.'
  );
  return lines.join('\n');
}
