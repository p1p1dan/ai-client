import { existsSync, realpathSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';

/**
 * Where is the Codex entry point, and what exactly do we spawn?
 *
 * ## The one rule this module exists to enforce
 *
 * Codex is ALWAYS launched as `node <…/@openai/codex/bin/codex.js> app-server`.
 * Never `spawn('codex')`, never the vendored native binary directly. This is a
 * user ruling (arbitration doc §0.5-④': "codex, like claude, must use the node
 * version, not the packaged one"), and `codex.js` is only a ~20KB launcher — it
 * spawns the 296MiB platform binary itself, so obeying the rule costs nothing
 * except the discipline of never resolving to a non-`.js` path.
 *
 * That discipline is load-bearing because the failure mode is INVISIBLE ON THIS
 * DEV MACHINE: on Linux + nvm, `which codex` realpaths straight to `codex.js`
 * [实测], so a naive "just use what's on PATH" implementation looks perfect here
 * and violates the ruling only on a packaged Windows box we cannot reach. Hence
 * every accepted path is filtered through `isCodexJsEntry`, and the test asserts
 * that EVERY candidate ends in `codex.js` — anyone adding a native-binary
 * fallback later goes red immediately.
 *
 * ## Shape: pure planner + injected probes
 *
 * `planCodexEntryCandidates` is pure (facts in, ordered candidate list out) and
 * `resolveCodexLaunch` takes its fs probes as options, so the packaged-Windows
 * layout — the only one that matters and the only one we cannot reproduce — is a
 * unit test rather than a hope.
 *
 * ## Candidate order (arbitration doc §3 / slice 2a)
 *
 *  1. `AICLIENT_CODEX_JS_PATH` — explicit escape hatch (also how tests and a
 *     future bundled layout point us at a file we did not predict).
 *  2. `codex` on PATH → realpath → accepted ONLY if it ends in `codex.js`.
 *     [实测] this machine: `~/.nvm/versions/node/v24.18.0/bin/codex` →
 *     `…/v24.18.0/lib/node_modules/@openai/codex/bin/codex.js`. If the realpath
 *     is extension-less (a standalone native distribution) it is REJECTED with
 *     `not-a-js-entry` — that rejected thing is precisely what the user forbade.
 *  3. Derived from the node executable we are told to launch with:
 *     posix `<dir(node)>/../lib/node_modules/@openai/codex/bin/codex.js`,
 *     win32 `<dir(node)>/node_modules/@openai/codex/bin/codex.js`.
 *     [实测] byte-identical to `npm root -g` on this machine.
 *  4. Step 3 repeated for every directory on PATH. THE ONLY REASON THIS EXISTS:
 *     in a packaged Windows app our node is the bundled
 *     `resources/node-runtime/node.exe`, which has no `node_modules` beside it
 *     (so step 3 misses), while the `codex` on PATH is a `.cmd` shim (so step 2
 *     rejects it). Step 4 is the sole branch that can hit there. Delete it and
 *     packaged Windows silently loses Codex.
 *  5. DELIBERATELY NOT DONE: `npm root -g`. It would need an npm child process
 *     and npm on PATH, and steps 2–4 already cover every layout measured on this
 *     machine. Do not "optimise" it back in.
 */

/** Which of the five rules produced a candidate; carried into the launch plan for logs. */
export type CodexEntrySource = 'env' | 'path_shim' | 'node_sibling' | 'path_node_sibling';

export interface CodexEntryCandidate {
  jsPath: string;
  source: CodexEntrySource;
}

/**
 * Everything the planner is allowed to know. No fs, no `process` — a caller can
 * describe a machine it does not have.
 *
 * `pathShimRealPath` is the ALREADY-RESOLVED target of the `codex` shim found on
 * PATH (resolving it is IO, so it happens in `resolveCodexLaunch`); leaving it
 * out means "no shim, or it did not resolve".
 */
export interface CodexEntryFacts {
  envOverride?: string;
  nodeExecPath: string;
  pathEnv: string;
  platform: NodeJS.Platform;
  pathShimRealPath?: string;
}

export interface CodexLaunchPlan {
  nodeExecPath: string;
  codexJsPath: string;
  /** `[codexJsPath, 'app-server']` — no shell, no PATH lookup, ever. */
  args: readonly string[];
  source: CodexEntrySource;
}

export type CodexEntryResolution =
  | { ok: true; plan: CodexLaunchPlan }
  | {
      ok: false;
      code: 'codex_entry_unresolved';
      message: string;
      inspected: Array<{ path: string; reason: string }>;
    };

/** The subcommand that puts codex in JSON-RPC server mode (S1 [实测]). */
export const CODEX_APP_SERVER_ARG = 'app-server';

/** Explicit escape hatch; also the thing the failure message tells the user to set. */
export const CODEX_JS_PATH_ENV = 'AICLIENT_CODEX_JS_PATH';

/**
 * Main injects the Node 24 path it resolved (`buildAgentHostEnv`), making an
 * otherwise implicit cross-process invariant explicit. We do NOT re-implement
 * `resolveNode24Runtime` here: the Host process is already running under that
 * binary, so `process.execPath` is the correct fallback rather than a guess.
 */
export const NODE_EXEC_PATH_ENV = 'AICLIENT_NODE_EXEC_PATH';

const CODEX_JS_BASENAME = 'codex.js';

/**
 * Path helpers for the TARGET platform, never the host's. Tests describe win32
 * layouts while running on Linux, so `node:path`'s platform-sensitive default
 * export would quietly build the wrong separators.
 */
function pathApi(platform: NodeJS.Platform): typeof posixPath {
  return platform === 'win32' ? win32Path : posixPath;
}

/**
 * The gate. Basename equality rather than a loose `.endsWith`, so `mycodex.js`
 * cannot sneak through, and case-SENSITIVE even on win32: a `CODEX.JS` spelling
 * is rejected with a loud error instead of weakening the invariant the test
 * enforces. Losing an absurd spelling is cheaper than losing the guarantee.
 */
export function isCodexJsEntry(candidate: string, platform: NodeJS.Platform): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return false;
  return pathApi(platform).basename(trimmed) === CODEX_JS_BASENAME;
}

/**
 * Global-install layout of `@openai/codex/bin/codex.js` relative to a node
 * executable. posix puts global packages in `<prefix>/lib/node_modules` with
 * node in `<prefix>/bin`; win32 puts them in `<prefix>\node_modules` with node
 * in `<prefix>` itself.
 */
export function codexJsFromNodeExec(nodeExecPath: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  const dir = p.dirname(nodeExecPath);
  return platform === 'win32'
    ? p.join(dir, 'node_modules', '@openai', 'codex', 'bin', CODEX_JS_BASENAME)
    : p.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', CODEX_JS_BASENAME);
}

function splitPathEnv(pathEnv: string, platform: NodeJS.Platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs: string[] = [];
  for (const raw of pathEnv.split(delimiter)) {
    // Windows tolerates quoted PATH entries; an unstripped quote makes every
    // derived path bogus while still *looking* like a plausible candidate.
    const entry = raw
      .trim()
      .replace(/^"+|"+$/g, '')
      .trim();
    if (entry.length > 0) dirs.push(entry);
  }
  return dirs;
}

/**
 * Ordered, de-duplicated candidate list. Pure.
 *
 * Note on rule 4: we derive from every PATH DIRECTORY without first checking a
 * node binary sits there. Requiring that would need an fs probe (killing purity)
 * and buys nothing — we launch with our own `nodeExecPath` regardless, so the
 * only question that matters is whether `codex.js` exists at the derived path,
 * which the caller probes anyway. The extra entries cost one `exists()` each.
 */
export function planCodexEntryCandidates(facts: CodexEntryFacts): CodexEntryCandidate[] {
  const { platform } = facts;
  const p = pathApi(platform);
  const candidates: CodexEntryCandidate[] = [];
  const seen = new Set<string>();

  const push = (jsPath: string, source: CodexEntrySource): void => {
    const trimmed = jsPath.trim();
    // The single choke point that makes "every candidate is a codex.js" true by
    // construction instead of by review.
    if (!isCodexJsEntry(trimmed, platform)) return;
    // Windows paths are case-insensitive, so `C:\A\codex.js` and `c:\a\codex.js`
    // are one candidate, not two probes.
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ jsPath: trimmed, source });
  };

  if (facts.envOverride) push(facts.envOverride, 'env');
  if (facts.pathShimRealPath) push(facts.pathShimRealPath, 'path_shim');
  if (facts.nodeExecPath.trim().length > 0) {
    push(codexJsFromNodeExec(facts.nodeExecPath.trim(), platform), 'node_sibling');
  }

  const nodeBinName = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of splitPathEnv(facts.pathEnv, platform)) {
    push(codexJsFromNodeExec(p.join(dir, nodeBinName), platform), 'path_node_sibling');
  }

  return candidates;
}

function defaultExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function defaultRealpath(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/** win32 npm installs both a `.cmd` shim and an extension-less sh script. */
function codexShimNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex.bat', 'codex'] : ['codex'];
}

function findOnPath(
  names: readonly string[],
  pathEnv: string,
  platform: NodeJS.Platform,
  exists: (candidate: string) => boolean
): string | null {
  const p = pathApi(platform);
  for (const dir of splitPathEnv(pathEnv, platform)) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** win32 spells it `Path`; an injected test env is a plain object with no case folding. */
function readPathEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function unresolvedMessage(inspectedCount: number): string {
  return (
    `Codex entry not found: none of the ${inspectedCount} inspected path(s) is an ` +
    `@openai/codex bin/${CODEX_JS_BASENAME}. Set ${CODEX_JS_PATH_ENV} to that file, ` +
    'or install the package (npm i -g @openai/codex). Codex is always launched as ' +
    `\`node <${CODEX_JS_BASENAME}> ${CODEX_APP_SERVER_ARG}\`; a native \`codex\` binary is not accepted.`
  );
}

/**
 * Resolve the launch plan. Synchronous and fully injectable — the fs probes are
 * options, so every layout is unit-testable.
 *
 * `nodeExecPath` precedence: explicit option (tests) → `AICLIENT_NODE_EXEC_PATH`
 * (Main's resolved Node 24) → `process.execPath` (already that same binary,
 * because Main spawned this Host with it).
 */
export function resolveCodexLaunch(
  opts: {
    env?: NodeJS.ProcessEnv;
    nodeExecPath?: string;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
    realpath?: (p: string) => string | null;
    whichCodex?: () => string | null;
  } = {}
): CodexEntryResolution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? defaultExists;
  const realpath = opts.realpath ?? defaultRealpath;
  const pathEnv = readPathEnv(env);
  const nodeExecPath =
    trimOrUndefined(opts.nodeExecPath) ??
    trimOrUndefined(env[NODE_EXEC_PATH_ENV]) ??
    process.execPath;
  const whichCodex =
    opts.whichCodex ??
    ((): string | null => findOnPath(codexShimNames(platform), pathEnv, platform, exists));

  // Rejections are recorded here rather than in the planner: the planner is pure
  // and has nowhere to report *why* it dropped something, but "we saw a codex on
  // PATH and refused it because it is not a .js entry" is the single most
  // important line in a support log for this feature.
  const inspected: Array<{ path: string; reason: string }> = [];

  const envOverride = trimOrUndefined(env[CODEX_JS_PATH_ENV]);
  if (envOverride && !isCodexJsEntry(envOverride, platform)) {
    inspected.push({ path: envOverride, reason: 'not-a-js-entry' });
  }

  const shim = trimOrUndefined(whichCodex());
  let pathShimRealPath: string | undefined;
  if (shim) {
    // A shim that cannot be resolved is judged as itself: a `.cmd` is still a
    // `.cmd`, and treating "realpath failed" as "unknown, try it" would be the
    // one path back to spawning a native binary.
    const resolved = trimOrUndefined(realpath(shim)) ?? shim;
    if (isCodexJsEntry(resolved, platform)) {
      pathShimRealPath = resolved;
    } else {
      inspected.push({ path: resolved, reason: 'not-a-js-entry' });
    }
  }

  const candidates = planCodexEntryCandidates({
    envOverride,
    nodeExecPath,
    pathEnv,
    platform,
    pathShimRealPath,
  });

  for (const candidate of candidates) {
    if (exists(candidate.jsPath)) {
      return {
        ok: true,
        plan: {
          nodeExecPath,
          codexJsPath: candidate.jsPath,
          args: Object.freeze([candidate.jsPath, CODEX_APP_SERVER_ARG]),
          source: candidate.source,
        },
      };
    }
    inspected.push({ path: candidate.jsPath, reason: 'not-found' });
  }

  return {
    ok: false,
    code: 'codex_entry_unresolved',
    message: unresolvedMessage(inspected.length),
    inspected,
  };
}
