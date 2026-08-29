#!/usr/bin/env node
/**
 * Dev server wrapper that ensures clean shutdown on Ctrl+C.
 * electron-vite doesn't properly forward SIGINT to Electron subprocess.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevPermissionPolicy } from './agent-host-build-lib.mjs';
import { CREDENTIAL_ENV_KEYS, CREDENTIAL_ENV_PREFIX } from './credential-env-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function readConstant(relativePath, pattern) {
  const filePath = join(root, relativePath);
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Failed to resolve constant from ${relativePath}`);
  }
  return match[1];
}

function getHostLinuxRuntimeArch() {
  if (process.platform !== 'linux') {
    return null;
  }

  if (process.arch === 'x64' || process.arch === 'arm64') {
    return process.arch;
  }

  return null;
}

function ensureLocalLinuxRuntimeBundle() {
  const arch = getHostLinuxRuntimeArch();
  if (!arch) {
    return;
  }

  const serverVersion = readConstant(
    'src/main/services/remote/RemoteHelperSource.ts',
    /REMOTE_SERVER_VERSION = '([^']+)'/
  );
  const nodeVersion = readConstant(
    'src/main/services/remote/RemoteRuntimeAssets.ts',
    /MANAGED_REMOTE_NODE_VERSION = '([^']+)'/
  );

  // Must match the producer (build-remote-runtime-bundle.mjs) and the consumer
  // (RemoteRuntimeAssets.ts remoteRuntimeArchiveName) — both say "aiclient-".
  // The old "enso-" prefix here never matched either, so this cache check
  // always missed and every `pnpm dev` on Linux rebuilt the ~48MB bundle.
  const archiveName = `aiclient-remote-runtime-v${serverVersion}-node-v${nodeVersion}-linux-${arch}.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const distRuntimeDir = join(root, 'dist', 'remote-runtime');
  const archivePath = join(distRuntimeDir, archiveName);
  const checksumPath = join(distRuntimeDir, checksumName);
  if (existsSync(archivePath) && existsSync(checksumPath)) {
    return;
  }

  const buildScriptPath = join(root, 'scripts', 'build-remote-runtime-bundle.mjs');
  const nodeExecutable = process.env.npm_node_execpath || process.env.NODE || 'node';

  console.log(`[dev] building Linux remote runtime bundle for ${arch}...`);
  const result = spawnSync(nodeExecutable, [buildScriptPath, `--arch=${arch}`], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

ensureLocalLinuxRuntimeBundle();

// ---------------------------------------------------------------------------
// Dev credentials (test/dev phase only)
//
// The Agent Host is spawned with {...process.env} and falls back to ~/.claude,
// so a bare `pnpm dev` silently routes GUI sessions through the developer's own
// Claude login. During development we pin credentials to `dev.env` instead:
// every inherited ANTHROPIC_*/Claude credential var is stripped, then only what
// `dev.env` declares is injected. Edit the file, restart dev — nothing else.
// ---------------------------------------------------------------------------

const DEV_ENV_FILE = process.env.AICLIENT_DEV_ENV_FILE || join(root, 'dev.env');
// D47 S2a §1: the credential-shaped prefix/key list is shared with Main
// (`src/main/index.ts`) via `credential-env-keys.mjs` — single source, a
// vitest asserts both sides resolve to the same list.
const STRIPPED_PREFIX = CREDENTIAL_ENV_PREFIX;
// D47 S1 §2.6: AICLIENT_MANAGED_CREDENTIALS rides along with the other
// credential-shaped vars — stripped from the inherited shell copy so a
// leftover export in the developer's shell can't silently flip it on. This
// key is dev.js-specific (the managed-credentials flag itself is not a
// "credential" var Main needs to redact), so it stays local rather than
// living in the shared list.
const MANAGED_CREDENTIALS_KEY = 'AICLIENT_MANAGED_CREDENTIALS';
// D60: `CLAUDE_CONFIG_DIR` left the shared credential list (Main must not
// delete a path the user chose). dev.js still clears it, because dev.js
// immediately sets its OWN isolated config dir below — clearing a variable
// you are about to overwrite is this script's business, not the shared
// list's. Same local-append arrangement as MANAGED_CREDENTIALS_KEY above.
const DEV_ISOLATED_CONFIG_DIR_KEY = 'CLAUDE_CONFIG_DIR';
const STRIPPED_KEYS = [
  ...CREDENTIAL_ENV_KEYS,
  MANAGED_CREDENTIALS_KEY,
  DEV_ISOLATED_CONFIG_DIR_KEY,
];

/**
 * D47 S1 §2.6 (A-track "dev 轮可开" + B-track "不被继承环境意外打开", 合取):
 * every `buildChildEnv` return path ends with this — only an explicit `'1'`
 * (from dev.env, or the original shell env captured before stripping) keeps
 * managed credentials on for the dev child process; anything else, including
 * an inherited-but-wrong-shaped value, is forced to `'0'`.
 *
 * D64/S3 — this variable is no longer THE switch, it is a DEV-ONLY OVERRIDE of
 * one. The real answer now lives in `~/.pilab/<profile>/settings.json` and is a
 * user's choice; the env var only wins in an unpackaged build
 * (`shared/credentialMode.ts`), which is exactly this script's case.
 *
 * The forced `'0'` therefore means something it did not mean before. It used to
 * be "off"; it is now "force LOCAL", overriding whatever the settings file
 * records. That is the right default for `pnpm dev` — a dev run should not
 * silently pick up a managed session from a settings file — but it does mean a
 * developer wanting the settings file to decide has to remove the key from
 * `dev.env` rather than set it to `0`.
 */
function resolveManagedCredentialsForDev(explicitValue) {
  return explicitValue === '1' ? '1' : '0';
}

/** Minimal dotenv: `KEY=VALUE`, `#` comments, optional quotes and `export `. */
function parseEnvFile(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

function maskSecret(value) {
  if (!value) return '(empty)';
  return value.length <= 8 ? '***' : `${value.slice(0, 6)}…***(${value.length} chars)`;
}

/**
 * Isolate CLAUDE_CONFIG_DIR so the CLI cannot reach ~/.claude/settings.json or
 * the OAuth credentials in ~/.claude/.credentials.json. Seeded from dev.env.
 */
function seedIsolatedConfigDir(vars) {
  const configDir = join(root, 'node_modules', '.cache', 'aiclient-dev-credentials');
  const settingsEnv = {};
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    if (vars[key]) settingsEnv[key] = vars[key];
  }
  const settings = { env: settingsEnv };
  if (vars.ANTHROPIC_MODEL) settings.model = vars.ANTHROPIC_MODEL;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

  // Pre-trust the workspaces so cli.js does not park on the first-run trust prompt.
  const claudeJsonPath = join(configDir, '.claude.json');
  let config = { hasCompletedOnboarding: true, projects: {} };
  if (existsSync(claudeJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      config = { ...existing, hasCompletedOnboarding: true, projects: existing.projects ?? {} };
    } catch {
      // Unreadable — rewrite from scratch.
    }
  }
  const trusted = (vars.AICLIENT_TRUSTED_WORKSPACES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const workspace of [root, ...trusted]) {
    config.projects[workspace] = {
      ...config.projects[workspace],
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
  }
  writeFileSync(claudeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  return configDir;
}

function buildChildEnv(allowLocal) {
  const env = { ...process.env };
  // Captured before stripping so an explicit shell export still counts as
  // "explicit" for resolveManagedCredentialsForDev below, even though the
  // STRIPPED_KEYS loop is about to delete it from `env`.
  const originalManagedCredentials = process.env[MANAGED_CREDENTIALS_KEY];

  const stripped = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith(STRIPPED_PREFIX) || STRIPPED_KEYS.includes(key)) {
      delete env[key];
      stripped.push(key);
    }
  }

  if (!existsSync(DEV_ENV_FILE)) {
    if (allowLocal) {
      console.warn(`[dev] ${DEV_ENV_FILE} not found — running with LOCAL credentials (~/.claude).`);
      const fallbackEnv = { ...process.env };
      fallbackEnv[MANAGED_CREDENTIALS_KEY] = resolveManagedCredentialsForDev(
        originalManagedCredentials
      );
      return fallbackEnv;
    }
    console.error(`[dev] Missing credentials file: ${DEV_ENV_FILE}`);
    console.error('[dev] Refusing to start: the app would fall back to your personal ~/.claude');
    console.error('[dev]   login and bill your own account.');
    console.error('[dev] Fix: cp dev.env.example dev.env   # then put your key in it');
    console.error(
      '[dev] Override (not recommended): node scripts/dev.js --allow-local-credentials'
    );
    process.exit(1);
  }

  const vars = parseEnvFile(readFileSync(DEV_ENV_FILE, 'utf8'));
  if (!vars.ANTHROPIC_AUTH_TOKEN && !vars.ANTHROPIC_API_KEY) {
    console.error(`[dev] ${DEV_ENV_FILE} sets neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY.`);
    process.exit(1);
  }
  // A stale API key wins over the token in some CLI paths — never send both.
  if (vars.ANTHROPIC_AUTH_TOKEN) delete vars.ANTHROPIC_API_KEY;

  Object.assign(env, vars);
  if (!vars.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = seedIsolatedConfigDir(vars);
  }
  // dev.env's own value wins if set; otherwise fall back to what the shell
  // had before stripping. Either way only an exact '1' survives.
  env[MANAGED_CREDENTIALS_KEY] = resolveManagedCredentialsForDev(
    vars[MANAGED_CREDENTIALS_KEY] ?? originalManagedCredentials
  );

  console.log(`[dev] credentials: ${DEV_ENV_FILE}`);
  console.log(
    `[dev]   ANTHROPIC_BASE_URL = ${env.ANTHROPIC_BASE_URL ?? '(default api.anthropic.com)'}`
  );
  console.log(
    `[dev]   ${env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'} = ${maskSecret(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY)}`
  );
  console.log(`[dev]   CLAUDE_CONFIG_DIR  = ${env.CLAUDE_CONFIG_DIR}`);
  console.log(
    `[dev]   AICLIENT_MANAGED_CREDENTIALS = ${env[MANAGED_CREDENTIALS_KEY]} (dev-only override; '1'=managed, '0'=force local)`
  );
  // D47 S5 §1.3 — the resolved value of the login-gate escape hatch
  // (`resolveSkipAuthGate`, src/shared/devFlags.ts). Not stripped/redacted:
  // it is a plain boolean-shaped switch, never a credential.
  console.log(`[dev]   AICLIENT_SKIP_AUTH_GATE = ${env.AICLIENT_SKIP_AUTH_GATE ?? '(unset)'}`);
  if (stripped.length > 0) {
    console.log(`[dev]   stripped from shell: ${stripped.join(', ')}`);
  }
  return env;
}

// T08-c — give the dev Host the same shipped permission policy the packaged app
// has. The Host resolves its plugin relative to its own entry, which in dev is
// `src/agent-host/`; without this the two builds enforce different rules and the
// difference is silent (dev just asks about more things).
const devPolicy = ensureDevPermissionPolicy(root);
console.log(
  devPolicy.written
    ? `[dev] permission policy: ${devPolicy.path}`
    : `[dev] permission policy NOT written: ${devPolicy.reason}`
);

// Start electron-vite in a new process group so we can kill the entire tree
// On Linux, --no-sandbox is needed when unprivileged user namespaces are disabled.
// Also forward our own CLI args to the app (`pnpm dev -- --open-path=<repo>`):
// electron-vite passes everything after `--` to Electron, and main/index.ts
// consumes --open-path to register a repository — the only way to do that on a
// machine where the legacy Add Repository UI is unreachable.
const ownArgs = process.argv.slice(2);
const allowLocalCredentials = ownArgs.includes('--allow-local-credentials');
const electronArgs = ['electron-vite', 'dev'];
const passthroughArgs = [
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  // --allow-local-credentials is ours; everything else goes to Electron.
  ...ownArgs.filter((arg) => arg !== '--allow-local-credentials'),
];
if (passthroughArgs.length > 0) {
  electronArgs.push('--', ...passthroughArgs);
}
const child = spawn('npx', electronArgs, {
  cwd: root,
  stdio: 'inherit',
  env: buildChildEnv(allowLocalCredentials),
  shell: process.platform === 'win32', // Use shell on Windows to avoid EINVAL errors
  detached: process.platform !== 'win32', // Create new process group on Unix
});

let shuttingDown = false;

function sleep(ms) {
  const durationMs = Number(ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;

  if (process.platform === 'win32') {
    // `ping -n` is seconds-based; `-n (seconds + 1)` because the first ping is sent immediately.
    const seconds = Math.ceil(durationMs / 1000);
    spawnSync('ping', ['-n', String(seconds + 1), '127.0.0.1'], { stdio: 'ignore' });
    return;
  }

  // macOS/Linux: `sleep` supports fractional seconds on typical environments.
  spawnSync('sleep', [String(durationMs / 1000)], { stdio: 'ignore' });
}

function collectProcessTreePids(rootPid) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') return [rootPid];

  const childrenByParent = new Map();
  for (const line of ps.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidStr, ppidStr] = trimmed.split(/\s+/, 2);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }

  const pids = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    const children = childrenByParent.get(pid);
    if (children) stack.push(...children);
  }
  return pids;
}

function signalPids(pids, signal) {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] ${signal} - shutting down...`);

  if (child.pid) {
    if (process.platform === 'win32') {
      // Windows: use taskkill to kill process tree
      spawnSync('taskkill', ['/pid', child.pid.toString(), '/t', '/f'], { stdio: 'ignore' });
    } else {
      // Unix: kill the entire process tree (Electron may spawn its own process group)
      const pids = collectProcessTreePids(child.pid);
      signalPids(pids, 'SIGTERM');
      if (pids.length <= 1) {
        // Fallback: try killing the whole process group when process tree is unavailable
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
      sleep(400);
      signalPids(pids, 'SIGKILL');
      if (pids.length <= 1) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
child.on('close', (code) => process.exit(shuttingDown ? 0 : (code ?? 0)));
