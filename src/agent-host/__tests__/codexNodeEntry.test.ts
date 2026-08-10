import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_ARG,
  CODEX_JS_PATH_ENV,
  type CodexEntryFacts,
  codexJsFromNodeExec,
  isCodexJsEntry,
  NODE_EXEC_PATH_ENV,
  planCodexEntryCandidates,
  resolveCodexLaunch,
} from '../codexNodeEntry.ts';

/**
 * The user ruling behind this module ("codex, like claude, must run the node
 * version, not the packaged one") has exactly one failure path — resolving to a
 * native binary — and that path CANNOT BE REPRODUCED ON THIS DEV MACHINE
 * (Linux + nvm, where `which codex` already realpaths to `codex.js`). So the
 * assertions carry more weight than the implementation: the packaged-Windows
 * layout below is constructed, not observed, and it is the only place the
 * regression can ever be caught.
 *
 * Every `it` states what it falsifies.
 *
 * Evidence markers: [实测] = verified on this machine in this session;
 * [构造] = hand-built layout for a machine we cannot reach.
 */

/** win32 paths are case-insensitive; a real fs would not care about casing. */
function makeExists(present: readonly string[], platform: NodeJS.Platform): (p: string) => boolean {
  const set = new Set(present.map((p) => (platform === 'win32' ? p.toLowerCase() : p)));
  return (p: string) => set.has(platform === 'win32' ? p.toLowerCase() : p);
}

// ---------------------------------------------------------------------------
// [实测] this machine, verified with `which codex` + `readlink -f`:
//   /home/dan/.nvm/versions/node/v24.18.0/bin/codex
//     -> /home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/bin/codex.js
// ---------------------------------------------------------------------------
const NVM_BIN = '/home/dan/.nvm/versions/node/v24.18.0/bin';
const NVM_NODE = `${NVM_BIN}/node`;
const NVM_CODEX_SHIM = `${NVM_BIN}/codex`;
const NVM_CODEX_JS =
  '/home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/bin/codex.js';

// [构造] packaged Windows app: our node is the bundled runtime, which has no
// node_modules beside it; the `codex` on PATH is a `.cmd` shim; the only real
// codex.js sits next to a *different* node (nvm4w) further down PATH.
const WIN_APP_NODE = 'C:\\app\\resources\\node-runtime\\node.exe';
const WIN_NVM4W_DIR = 'C:\\nvm4w\\nodejs';
const WIN_NPM_DIR = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const WIN_CODEX_CMD = `${WIN_NPM_DIR}\\codex.cmd`;
const WIN_CODEX_JS = `${WIN_NVM4W_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const WIN_PATH = [
  'C:\\app\\resources\\node-runtime',
  WIN_NVM4W_DIR,
  WIN_NPM_DIR,
  'C:\\Windows\\system32',
].join(';');

describe('codexJsFromNodeExec', () => {
  it('reproduces the measured nvm global layout byte for byte', () => {
    // Falsifies: any off-by-one in the `../lib/node_modules` climb, and any
    // reliance on the host platform's separators. The expected string is the
    // literal output of `readlink -f $(which codex)` on this machine [实测], so
    // if the derivation drifts from the real npm layout this goes red.
    expect(codexJsFromNodeExec(NVM_NODE, 'linux')).toBe(NVM_CODEX_JS);
  });

  it('uses the win32 layout (node_modules beside node, not under ../lib)', () => {
    // Falsifies: copying the posix rule to Windows, where npm's global prefix IS
    // the node directory. Running on Linux, so this also proves `path.win32` is
    // taken explicitly rather than inherited from the host.
    expect(codexJsFromNodeExec(WIN_APP_NODE, 'win32')).toBe(
      'C:\\app\\resources\\node-runtime\\node_modules\\@openai\\codex\\bin\\codex.js'
    );
    expect(codexJsFromNodeExec(`${WIN_NVM4W_DIR}\\node.exe`, 'win32')).toBe(WIN_CODEX_JS);
  });
});

describe('planCodexEntryCandidates — the no-native-binary invariant', () => {
  const factsTable: Array<{ name: string; facts: CodexEntryFacts }> = [
    {
      name: 'posix dev machine with a .js shim target [实测]',
      facts: {
        nodeExecPath: NVM_NODE,
        pathEnv: `${NVM_BIN}:/usr/local/bin:/usr/bin`,
        platform: 'linux',
        pathShimRealPath: NVM_CODEX_JS,
      },
    },
    {
      name: 'posix machine whose codex realpaths to an extension-less binary [构造]',
      facts: {
        nodeExecPath: NVM_NODE,
        pathEnv: `${NVM_BIN}:/usr/local/bin`,
        platform: 'linux',
        pathShimRealPath: '/usr/local/lib/codex-0.145.0/codex',
      },
    },
    {
      name: 'packaged win32 with a .cmd shim on PATH [构造]',
      facts: {
        nodeExecPath: WIN_APP_NODE,
        pathEnv: WIN_PATH,
        platform: 'win32',
        pathShimRealPath: WIN_CODEX_CMD,
      },
    },
    {
      name: 'env override pointing at a native binary [构造]',
      facts: {
        envOverride: '/opt/codex/bin/codex',
        nodeExecPath: NVM_NODE,
        pathEnv: NVM_BIN,
        platform: 'linux',
      },
    },
    {
      name: 'win32 with quoted PATH entries and a stray empty one [构造]',
      facts: {
        nodeExecPath: WIN_APP_NODE,
        pathEnv: `"${WIN_NVM4W_DIR}";;  ;"${WIN_NPM_DIR}"`,
        platform: 'win32',
      },
    },
    {
      name: 'darwin homebrew layout [构造]',
      facts: {
        nodeExecPath: '/opt/homebrew/bin/node',
        pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
        platform: 'darwin',
        pathShimRealPath: '/opt/homebrew/Cellar/codex/0.145.0/bin/codex',
      },
    },
  ];

  for (const { name, facts } of factsTable) {
    it(`only ever proposes codex.js entries — ${name}`, () => {
      const candidates = planCodexEntryCandidates(facts);

      // Negative control FIRST: "every element satisfies P" is vacuously true
      // for an empty list, so an implementation that proposed nothing at all
      // would pass the real assertion below. It must not.
      expect(candidates.length).toBeGreaterThan(0);

      // THE assertion. This is the executable form of the user ruling: the day
      // someone adds a "fall back to the native binary / to PATH codex" branch,
      // this line goes red for every layout at once.
      for (const candidate of candidates) {
        expect(candidate.jsPath.endsWith('codex.js')).toBe(true);
      }
    });
  }

  it('drops a shim realpath that is not a .js entry instead of proposing it', () => {
    // Falsifies: "unknown extension, try it anyway" — the single behaviour that
    // would spawn the 296MiB vendored binary the user forbade.
    const native = '/usr/local/lib/codex-0.145.0/codex';
    const candidates = planCodexEntryCandidates({
      nodeExecPath: NVM_NODE,
      pathEnv: NVM_BIN,
      platform: 'linux',
      pathShimRealPath: native,
    });
    expect(candidates.map((c) => c.jsPath)).not.toContain(native);
    expect(candidates.some((c) => c.source === 'path_shim')).toBe(false);
  });

  it('drops an env override that is not a .js entry', () => {
    // Falsifies: treating the escape hatch as unchecked. The escape hatch may
    // pick a different codex.js; it may not re-open the native-binary path.
    const candidates = planCodexEntryCandidates({
      envOverride: '/opt/codex/bin/codex',
      nodeExecPath: NVM_NODE,
      pathEnv: NVM_BIN,
      platform: 'linux',
    });
    expect(candidates.some((c) => c.source === 'env')).toBe(false);
  });
});

describe('planCodexEntryCandidates — ordering and de-duplication', () => {
  it('orders env -> path_shim -> node_sibling -> path_node_sibling', () => {
    // Falsifies: any reshuffle of the contract order. Ordering is behaviour, not
    // taste: the explicit override must beat a stale global install, and the
    // PATH sweep must stay last because it is the widest (and noisiest) rule.
    // Four distinct paths on purpose: de-duplication (asserted below) would
    // otherwise hide a source in the expected list.
    const candidates = planCodexEntryCandidates({
      envOverride: '/opt/custom/codex.js',
      nodeExecPath: '/usr/bin/node',
      pathEnv: '/other/bin',
      platform: 'linux',
      pathShimRealPath: NVM_CODEX_JS,
    });
    expect(candidates.map((c) => c.source)).toEqual([
      'env',
      'path_shim',
      'node_sibling',
      'path_node_sibling',
    ]);
  });

  it('emits one entry per path, keeping the earlier (stronger) source', () => {
    // Falsifies: a planner that probes the same file twice because dir(node) is
    // also on PATH — which is the normal case on every dev machine, and would
    // make the failure report list the same path repeatedly.
    const candidates = planCodexEntryCandidates({
      nodeExecPath: NVM_NODE,
      pathEnv: `${NVM_BIN}:${NVM_BIN}:/usr/bin`,
      platform: 'linux',
      pathShimRealPath: NVM_CODEX_JS,
    });
    const hits = candidates.filter((c) => c.jsPath === NVM_CODEX_JS);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('path_shim');
  });

  it('still proposes the node-sibling candidate when PATH is empty', () => {
    // Falsifies: making rule 3 depend on PATH. A packaged app may hand the Host
    // a nearly empty environment; the node we were told to run must still be
    // enough to find a co-installed codex.
    const candidates = planCodexEntryCandidates({
      nodeExecPath: NVM_NODE,
      pathEnv: '',
      platform: 'linux',
    });
    expect(candidates).toEqual([{ jsPath: NVM_CODEX_JS, source: 'node_sibling' }]);
  });

  it('strips quotes from win32 PATH entries', () => {
    // Falsifies: feeding `"C:\dir"` straight into path.join, which yields a path
    // that can never exist while still looking like a legitimate candidate in
    // the failure report.
    const candidates = planCodexEntryCandidates({
      nodeExecPath: WIN_APP_NODE,
      pathEnv: `"${WIN_NVM4W_DIR}"`,
      platform: 'win32',
    });
    expect(candidates.map((c) => c.jsPath)).toContain(WIN_CODEX_JS);
    for (const candidate of candidates) expect(candidate.jsPath).not.toContain('"');
  });
});

describe('resolveCodexLaunch — packaged Windows [构造]', () => {
  const base = {
    env: { Path: WIN_PATH } satisfies NodeJS.ProcessEnv,
    nodeExecPath: WIN_APP_NODE,
    platform: 'win32' as NodeJS.Platform,
    whichCodex: (): string | null => WIN_CODEX_CMD,
    // A .cmd is not a symlink: realpath returns itself.
    realpath: (p: string): string | null => p,
  };

  it('hits candidate 4 (path_node_sibling) when the bundled node has no siblings', () => {
    // Falsifies: deleting the PATH-node sweep as "redundant". On this layout it
    // is the ONLY rule that can succeed — rule 2 rejects the .cmd shim and rule 3
    // looks inside resources/node-runtime, where a packaged app has no
    // node_modules. Dev machines never exercise this branch.
    const result = resolveCodexLaunch({ ...base, exists: makeExists([WIN_CODEX_JS], 'win32') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.source).toBe('path_node_sibling');
    expect(result.plan.codexJsPath).toBe(WIN_CODEX_JS);
    // Launch with OUR node (the bundled Node 24), not the nvm4w one whose
    // node_modules happened to hold codex.
    expect(result.plan.nodeExecPath).toBe(WIN_APP_NODE);
    expect(result.plan.args).toEqual([WIN_CODEX_JS, CODEX_APP_SERVER_ARG]);
  });

  it('never resolves to the .cmd shim on PATH', () => {
    // Falsifies: `spawn('codex')` / shim reuse. Stated separately from the
    // source check so the intent survives a refactor of the source names.
    const result = resolveCodexLaunch({ ...base, exists: makeExists([WIN_CODEX_JS], 'win32') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.codexJsPath.endsWith('.cmd')).toBe(false);
    expect(result.plan.args).not.toContain(WIN_CODEX_CMD);
  });

  it('records the .cmd shim as not-a-js-entry when nothing resolves', () => {
    // Falsifies: silently ignoring the shim. The rejection reason is the single
    // most useful line in a support log ("we found codex and refused it, here is
    // why"), and it is only observable on the failure branch.
    const result = resolveCodexLaunch({ ...base, exists: makeExists([], 'win32') });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('codex_entry_unresolved');
    expect(result.inspected).toContainEqual({ path: WIN_CODEX_CMD, reason: 'not-a-js-entry' });
    // ...and the candidates it did try are listed, so the report is actionable.
    expect(result.inspected).toContainEqual({ path: WIN_CODEX_JS, reason: 'not-found' });
    expect(result.message).toContain(CODEX_JS_PATH_ENV);
    expect(result.message).toContain('@openai/codex');
  });
});

describe('resolveCodexLaunch — posix dev machine [实测]', () => {
  const posixEnv = { PATH: `${NVM_BIN}:/usr/bin` } satisfies NodeJS.ProcessEnv;

  it('takes the PATH shim when it realpaths to codex.js', () => {
    // Falsifies: ignoring the measured nvm layout. Here `which codex` ->
    // symlink -> codex.js [实测], so rule 2 is the correct (and shortest) hit.
    const result = resolveCodexLaunch({
      env: posixEnv,
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([NVM_CODEX_SHIM, NVM_CODEX_JS], 'linux'),
      realpath: (p) => (p === NVM_CODEX_SHIM ? NVM_CODEX_JS : p),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.source).toBe('path_shim');
    expect(result.plan.codexJsPath).toBe(NVM_CODEX_JS);
    expect(result.plan.args).toEqual([NVM_CODEX_JS, CODEX_APP_SERVER_ARG]);
  });

  it('reaches the same file through rule 3 when no shim is on PATH', () => {
    // Falsifies: a rule-3 derivation that disagrees with the real install. The
    // expected path is the measured `readlink -f` target [实测], so rules 2 and 3
    // are proven to agree on this machine — which is why losing the shim (or
    // running a packaged app) is not supposed to change anything here.
    const result = resolveCodexLaunch({
      env: posixEnv,
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([NVM_CODEX_JS], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.source).toBe('node_sibling');
    expect(result.plan.codexJsPath).toBe(NVM_CODEX_JS);
  });

  it('refuses a PATH codex that realpaths to an extension-less binary', () => {
    // Falsifies: the exact scenario the user ruled out — a standalone native
    // codex distribution being launched directly. It must be skipped WITH a
    // reason, and resolution must continue to the real codex.js.
    const native = '/usr/local/lib/codex-0.145.0/codex';
    const result = resolveCodexLaunch({
      env: posixEnv,
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([NVM_CODEX_JS], 'linux'),
      whichCodex: () => '/usr/local/bin/codex',
      realpath: () => native,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.codexJsPath).toBe(NVM_CODEX_JS);
    expect(result.plan.source).toBe('node_sibling');
  });

  it('reports every inspected path when nothing exists', () => {
    // Falsifies: an empty/opaque failure. Without `inspected` the only debugging
    // tool on a user machine is guesswork about which layouts we tried.
    const result = resolveCodexLaunch({
      env: posixEnv,
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.inspected.length).toBeGreaterThan(0);
    expect(result.inspected.every((entry) => entry.reason === 'not-found')).toBe(true);
    expect(result.inspected.map((entry) => entry.path)).toContain(NVM_CODEX_JS);
    expect(result.message).toContain(CODEX_JS_PATH_ENV);
  });
});

describe('resolveCodexLaunch — the explicit escape hatch', () => {
  it(`prefers ${CODEX_JS_PATH_ENV} over every discovered layout`, () => {
    // Falsifies: an override that only applies when discovery fails. The whole
    // point is to beat a stale global install on a user machine.
    const custom = '/opt/custom/codex/bin/codex.js';
    const result = resolveCodexLaunch({
      env: { PATH: NVM_BIN, [CODEX_JS_PATH_ENV]: `  ${custom}  ` },
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([custom, NVM_CODEX_JS], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.source).toBe('env');
    expect(result.plan.codexJsPath).toBe(custom);
  });

  it('rejects an override that points at a native binary, with a reason', () => {
    // Falsifies: trusting the env var blindly. An escape hatch that can violate
    // the ruling is not an escape hatch, it is the bug.
    const native = '/opt/codex/bin/codex';
    const result = resolveCodexLaunch({
      env: { PATH: '', [CODEX_JS_PATH_ENV]: native },
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([native], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.inspected).toContainEqual({ path: native, reason: 'not-a-js-entry' });
  });
});

describe('resolveCodexLaunch — which node we launch with', () => {
  it(`reads ${NODE_EXEC_PATH_ENV} injected by Main`, () => {
    // Falsifies: re-implementing Node-24 resolution inside the Host (arbitration
    // doc C-a: the resolver's real precedence differs from the design doc, so a
    // second copy would drift). The Host consumes Main's answer, it does not
    // recompute it.
    const result = resolveCodexLaunch({
      env: { PATH: '', [NODE_EXEC_PATH_ENV]: NVM_NODE },
      platform: 'linux',
      exists: makeExists([NVM_CODEX_JS], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nodeExecPath).toBe(NVM_NODE);
  });

  it('lets an explicit option win over the env var', () => {
    // Falsifies: an untestable resolver. Every other case in this file depends
    // on the option overriding the ambient environment.
    const other = '/usr/bin/node';
    const result = resolveCodexLaunch({
      env: { PATH: '', [NODE_EXEC_PATH_ENV]: NVM_NODE },
      nodeExecPath: other,
      platform: 'linux',
      exists: makeExists(['/usr/lib/node_modules/@openai/codex/bin/codex.js'], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nodeExecPath).toBe(other);
  });

  it('falls back to process.execPath when neither is given', () => {
    // Falsifies: a hard-coded default or a throw. The Host is already running
    // under the Node 24 binary Main resolved, so its own execPath is the correct
    // answer — this asserts the fallback is that value and nothing else.
    const derived = codexJsFromNodeExec(process.execPath, process.platform);
    const result = resolveCodexLaunch({
      env: { PATH: '' },
      exists: makeExists([derived], process.platform),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nodeExecPath).toBe(process.execPath);
    expect(result.plan.codexJsPath).toBe(derived);
  });

  it('always spawns `<codex.js> app-server` and nothing else', () => {
    // Falsifies: adding shell flags, `--`, or a PATH lookup of `codex`. The
    // argv shape is the last line of defence: even a wrong path here would still
    // be executed by node, never by the OS as a binary.
    const result = resolveCodexLaunch({
      env: { PATH: NVM_BIN },
      nodeExecPath: NVM_NODE,
      platform: 'linux',
      exists: makeExists([NVM_CODEX_JS], 'linux'),
      whichCodex: () => null,
      realpath: () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.args).toHaveLength(2);
    expect(result.plan.args[0]).toBe(result.plan.codexJsPath);
    expect(result.plan.args[1]).toBe('app-server');
  });
});

describe('isCodexJsEntry', () => {
  it('accepts only a file actually named codex.js', () => {
    // Falsifies: a loose `.endsWith('codex.js')`, which would accept
    // `/opt/mycodex.js`, and a loose `.endsWith('.js')`, which would accept any
    // script at all.
    expect(isCodexJsEntry('/a/b/codex.js', 'linux')).toBe(true);
    expect(isCodexJsEntry('C:\\a\\codex.js', 'win32')).toBe(true);
    expect(isCodexJsEntry('/a/b/mycodex.js', 'linux')).toBe(false);
    expect(isCodexJsEntry('/a/b/codex', 'linux')).toBe(false);
    expect(isCodexJsEntry('/a/b/codex.cmd', 'win32')).toBe(false);
    expect(isCodexJsEntry('   ', 'linux')).toBe(false);
  });
});
