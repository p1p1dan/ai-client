/**
 * D47 S2a §1/§2 — pure generators for the managed claude-home tree. Zero
 * `electron` import: every path is passed in by the caller.
 * `main/index.ts` (skeleton + regenerate), `OnboardingService` (login/logout
 * regenerate) and the trust call matrix (`main/ipc/chat.ts`,
 * `SessionManager.create`) own the electron-facing orchestration; this
 * module only knows how to produce the JSON shapes and the trust mutation.
 */

import { join } from 'node:path';
import { writeSettingsFile } from './managedFileWriter';

const CLAUDE_HOME_DIR_NAME = 'claude-home';

/** `<userData>/claude-home` — the managed redirect target for `CLAUDE_CONFIG_DIR`. */
export function getManagedClaudeHomeDir(userDataDir: string): string {
  return join(userDataDir, CLAUDE_HOME_DIR_NAME);
}

/** Sidecar filename (D47 S2a §1) — never a settings.json/.claude.json key ("no unknown keys" contract). */
export const AICLIENT_GENERATED_SIDECAR_NAME = '.aiclient-generated';

export interface GeneratedSidecarStamp {
  version: string;
  commit: string;
  generatedAt: string;
}

/**
 * D47 S2a §1 — the generated-artifact header: `<claude-home>/.aiclient-generated`
 * (version/commit/timestamp). Kept OUT of settings.json entirely — the spec
 * explicitly bans stuffing unverified keys into settings.json
 * (`__generated__` was never CLI-verified), so this ships as a sibling file
 * instead.
 */
export function generateSidecarStamp(
  version: string,
  commit: string,
  generatedAt: string = new Date().toISOString()
): GeneratedSidecarStamp {
  return { version, commit, generatedAt };
}

export interface ClaudeHomeCredentials {
  baseUrl: string;
  authToken: string;
}

export interface ClaudeSettingsPatch {
  env: Record<string, string>;
  autoUpdates: false;
  skipWebFetchPreflight: true;
}

/**
 * D47 S2a §2 — the managed settings.json key set: `env` (3 keys, or `{}`
 * when there are no credentials to write) + `autoUpdates:false` +
 * `skipWebFetchPreflight:true`. Returns a PATCH, not a full document —
 * callers spread it over the freshly-read `current` inside a
 * `managedFileWriter.writeSettingsFile` mutator so foreign keys
 * (hooks/statusLine/enabledPlugins/unknown) survive untouched.
 */
export function generateClaudeSettings(
  credentials: ClaudeHomeCredentials | null
): ClaudeSettingsPatch {
  return {
    env: credentials
      ? {
          ANTHROPIC_BASE_URL: credentials.baseUrl,
          ANTHROPIC_AUTH_TOKEN: credentials.authToken,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        }
      : {},
    autoUpdates: false,
    skipWebFetchPreflight: true,
  };
}

/** Minimal fresh `.claude.json`: pre-completed onboarding, empty project trust map. */
export function generateClaudeJson(): Record<string, unknown> {
  return { hasCompletedOnboarding: true, projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * D47 S2a trust call matrix — marks `wsPath` as trusted in `claudeJsonPath`'s
 * `projects` map, going through `managedFileWriter.writeSettingsFile` so
 * concurrent trust writes for different workspaces serialize instead of
 * racing. `wsPath` must already be `path.resolve`-normalized by the caller
 * (Windows case/separator differences are the caller's job, not this one's).
 */
export async function ensureWorkspaceTrusted(
  claudeJsonPath: string,
  wsPath: string
): Promise<void> {
  await writeSettingsFile(claudeJsonPath, (current) => {
    // `{ ...generateClaudeJson(), ...current }`: when `current` is `{}`
    // (file absent, or just rebuilt from a corrupt-JSON degrade), this fills
    // in the minimal managed shape; when `current` already has content,
    // its own keys win over the defaults.
    const base = { ...generateClaudeJson(), ...current };
    const projects = isRecord(base.projects) ? { ...base.projects } : {};
    const existingEntry = isRecord(projects[wsPath])
      ? (projects[wsPath] as Record<string, unknown>)
      : {};

    return {
      ...base,
      projects: {
        ...projects,
        [wsPath]: {
          ...existingEntry,
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    };
  });
}
