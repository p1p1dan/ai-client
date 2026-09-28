/**
 * The DSH host's environment (dsh-rebase decision 022), as a pure function.
 *
 * `DshHostProcess.ts` builds every launch with it, and
 * `scripts/packaged-dsh-host-smoke.mjs` imports this file directly so the
 * smoke runs the host with exactly Main's rule. Node loads it there by type
 * stripping: erasable syntax only, and no imports.
 */

/**
 * Credential-shaped names, the same rule DSH applies to every tool it spawns
 * (`SENSITIVE_ENV_PATTERN` in @deepseek-ai/dsh-subprocess). Dropping them from
 * the host too closes pi-ai's fallback of looking up a provider key in the
 * launch environment. A static test pins it to the installed DSH package.
 */
export const DSH_SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Runtime injection: `--require` hooks, debug ports, module resolution outside the host. */
const STRIPPED_ENV_NAMES = ['NODE_OPTIONS', 'NODE_PATH'];

/**
 * Electron's switches and the app's own: anything the host needs from these
 * families is set explicitly below. Matched case-insensitively, as DSH matches
 * `DSH_*`: Windows names are case-insensitive.
 */
const STRIPPED_ENV_PREFIXES = ['ELECTRON_', 'AICLIENT_', 'DSH_', 'VITE_'];

/**
 * Package-manager lifecycle variables from a `pnpm dev` launch. Lower-case by
 * npm's convention, so a user's own `NPM_CONFIG_*` keeps reaching tools.
 */
const STRIPPED_LIFECYCLE_PREFIX = 'npm_';

/**
 * App switches the host itself reads, forwarded packaged or not: the loop
 * guard's emergency kill switch (dsh-rebase decision 065; `0` turns the
 * `aiclient-loop-guard` row off), under 1.0.x's name.
 */
const FORWARDED_ENV = ['AICLIENT_RUNTIME_LOOP_GUARD'];

/** Whether an inherited variable stays behind (decision 022). */
export function isStrippedDshHostEnvName(name: string): boolean {
  if (DSH_SENSITIVE_ENV_PATTERN.test(name)) return true;
  const upper = name.toUpperCase();
  if (STRIPPED_ENV_NAMES.includes(upper)) return true;
  if (STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return name.startsWith(STRIPPED_LIFECYCLE_PREFIX);
}

/** Set `name`, first dropping any spelling Windows would treat as the same variable. */
export function setDshHostEnvEntry(
  env: Record<string, string>,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === upper) delete env[existing];
    }
  }
  env[name] = value;
}

/**
 * The host's whole environment (decision 022): Main's, minus runtime
 * injection, Electron and app-internal switches, and credential-shaped names;
 * plus the explicit settings below. It is also the base of every tool the host
 * spawns, so it keeps what 1.0.x tools saw (`SSH_AUTH_SOCK`, `JAVA_HOME`,
 * proxies, `XDG_RUNTIME_DIR` and DBus for systemd containment).
 *
 * No key is ever added back, packaged or not (P1-5, decisions 033 and 034):
 * routes come with Main's model plan over IPC, and keys per request.
 */
export function buildDshHostEnvironment(input: {
  dshHome: string;
  nativeCacheDir: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const source = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const hostEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isStrippedDshHostEnvName(name)) hostEnv[name] = value;
  }
  const explicit: Record<string, string> = {
    DSH_HOME: input.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NARB_NATIVE_CACHE_DIR: input.nativeCacheDir,
  };
  for (const name of FORWARDED_ENV) {
    const value = source[name];
    if (value !== undefined) explicit[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    setDshHostEnvEntry(hostEnv, name, value, platform);
  }
  return hostEnv;
}
