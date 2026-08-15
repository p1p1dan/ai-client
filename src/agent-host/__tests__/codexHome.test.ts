import { describe, expect, it } from 'vitest';
import {
  CODEX_CONFIG_HEADER,
  CODEX_CONFIG_ROOT_ALLOWLIST,
  CODEX_CONFIG_TABLE_ALLOWLIST,
  CODEX_PERMISSION_CONFIG_KEYS,
  type CodexHomeFs,
  ensureCodexHome,
  projectCodexConfig,
  resolveSourceCodexHome,
} from '../codexHome.ts';
import { CODEX_PERMISSION_DEFAULT } from '../codexRuntime.ts';

/**
 * The single most important property under test is NEGATIVE: nothing outside the
 * allowlist may reach the generated config — with ONE addition since S3 slice 5b
 * (H9 layer 1): the two posture keys, which this module now WRITES from the
 * caller's constant instead of merely dropping the user's. Every `it` below names
 * what it falsifies, because a projection test that only checks "the good keys
 * survived" passes just as happily on a straight file copy.
 */

/**
 * The posture under test is the runtime's own constant, never a literal: the
 * whole point of H9 layer 1 is that `thread/start` and this file cannot disagree,
 * and a test that spelled `'on-request'` here would keep passing after one of the
 * two sides was changed.
 */
const POSTURE = CODEX_PERMISSION_DEFAULT;

/**
 * A realistic third-party-proxy config, shaped like the one on the dev machine
 * ([实测] `sandbox_mode = "danger-full-access"`, a proxy `base_url`, and a
 * `developer_instructions` block — the S1 §6.2 C5 root cause of three turns
 * where the model answered in prose and called zero tools).
 *
 * The instruction block deliberately contains lines that LOOK like root
 * assignments; that is the trap a line-by-line filter falls into.
 */
const REALISTIC_SOURCE = `# my codex config
model = "gpt-5.6-sol"
model_provider = "thirdparty"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "danger-full-access"
disable_response_storage = true
notify = ["notify-send", "codex"]

developer_instructions = """
Never touch code without explicit permission.
model = "leaked-from-instructions"
approval_policy = "leaked-from-instructions"
sandbox_mode = "leaked-from-instructions"
"""

[model_providers.thirdparty]
name = "Third Party Proxy"
base_url = "https://proxy.invalid/v1"
wire_api = "responses"
env_key = "THIRDPARTY_API_KEY"
requires_openai_auth = true

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]

[history]
persistence = "save-all"

[profiles.work]
model = "gpt-5.6-mini"

[projects."/workspace/demo"]
trust_level = "trusted"
`;

/**
 * Keys that must never appear in the generated body at all.
 *
 * `approval_policy` / `sandbox_mode` LEFT this list in slice 5b and that is not a
 * relaxation: the user's values are still dropped (they are asserted in `dropped`
 * below, and their VALUES are asserted absent), but the two keys are now written
 * back from our own posture, because `thread/resume` re-derives the posture from
 * this file [实测].
 */
const BANNED = [
  'developer_instructions',
  'mcp_servers',
  'notify',
  'profiles',
  'projects',
  'history',
] as const;

/** The user's own posture values in `REALISTIC_SOURCE` — none may survive. */
const BANNED_POSTURE_VALUES = ['never', 'danger-full-access'] as const;

/** `dropped` records a rejected table by its own path, so match the prefix too. */
function wasDropped(dropped: readonly string[], name: string): boolean {
  return dropped.some((entry) => entry === name || entry.startsWith(`${name}.`));
}

/** Non-comment, non-blank lines of a generated config. */
function bodyLines(toml: string): string[] {
  return toml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The config body without the header. The header NAMES the banned keys on
 * purpose (it is the note to whoever opens the file), so "did a banned key
 * survive" must be asked of the TOML that codex will actually parse.
 */
function configBody(toml: string): string {
  return bodyLines(toml).join('\n');
}

interface FakeFile {
  data: string;
  mode: number | null;
  mtimeMs: number;
}

interface FakeFs extends CodexHomeFs {
  files: Map<string, FakeFile>;
  dirs: Set<string>;
  writes: string[];
  copies: Array<{ from: string; to: string }>;
  chmods: Array<{ path: string; mode: number }>;
}

function createFakeFs(seed: Record<string, { data: string; mtimeMs?: number }> = {}): FakeFs {
  const files = new Map<string, FakeFile>();
  for (const [path, file] of Object.entries(seed)) {
    files.set(path, { data: file.data, mode: null, mtimeMs: file.mtimeMs ?? 1_000 });
  }
  const dirs = new Set<string>();
  const writes: string[] = [];
  const copies: Array<{ from: string; to: string }> = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  return {
    files,
    dirs,
    writes,
    copies,
    chmods,
    existsSync: (path) => files.has(path) || dirs.has(path),
    mkdirSync: (path) => {
      dirs.add(path);
    },
    readFileSync: (path) => {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return file.data;
    },
    writeFileSync: (path, data, options) => {
      files.set(path, { data, mode: options.mode, mtimeMs: 2_000 });
      writes.push(path);
    },
    copyFileSync: (from, to) => {
      const file = files.get(from);
      if (!file) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.set(to, { data: file.data, mode: null, mtimeMs: file.mtimeMs });
      copies.push({ from, to });
    },
    chmodSync: (path, mode) => {
      const file = files.get(path);
      if (file) file.mode = mode;
      chmods.push({ path, mode });
    },
    statSync: (path) => {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { mtimeMs: file.mtimeMs };
    },
  };
}

const AUTH_SECRET = '{"OPENAI_API_KEY":"sk-live-DO-NOT-LOG-me"}';

function seededHome(): FakeFs {
  return createFakeFs({
    '/src/.codex/config.toml': { data: REALISTIC_SOURCE, mtimeMs: 1_000 },
    '/src/.codex/auth.json': { data: AUTH_SECRET, mtimeMs: 1_000 },
  });
}

describe('projectCodexConfig', () => {
  it('keeps model / model_provider / model_providers.* from a realistic source', () => {
    // Falsifies: an over-eager allowlist that drops the proxy settings and leaves
    // codex talking to api.openai.com (or to nothing) on every turn.
    const { toml, kept } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    expect(toml).toContain('model = "gpt-5.6-sol"');
    expect(toml).toContain('model_provider = "thirdparty"');
    expect(toml).toContain('[model_providers.thirdparty]');
    expect(toml).toContain('base_url = "https://proxy.invalid/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "THIRDPARTY_API_KEY"');
    expect(kept).toEqual(
      expect.arrayContaining([
        'model',
        'model_provider',
        'model_providers.thirdparty.base_url',
        'model_providers.thirdparty.wire_api',
        'model_providers.thirdparty.env_key',
      ])
    );
  });

  it('emits nothing outside the allowlist, and reports each drop', () => {
    // THE load-bearing assertion of this file. Falsifies: any copy-through or
    // blacklist implementation. `sandbox_mode = "danger-full-access"` inherited
    // = every approval prompt silently disabled; `developer_instructions`
    // inherited = the three measured zero-tool-call turns (S1 §6.2 C5).
    const { toml, dropped } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);
    const body = configBody(toml);

    for (const banned of BANNED) {
      expect(body).not.toContain(banned);
      expect(wasDropped(dropped, banned)).toBe(true);
    }
    // The two posture keys are the one thing the body may name that the source
    // also named — their VALUES still have to be ours, and the user's must be
    // reported as dropped exactly as before.
    for (const value of BANNED_POSTURE_VALUES) {
      expect(body).not.toContain(`"${value}"`);
    }
    for (const key of Object.values(CODEX_PERMISSION_CONFIG_KEYS)) {
      expect(wasDropped(dropped, key)).toBe(true);
    }
    expect(body).not.toContain('save-all');
  });

  it('drops unknown keys instead of passing them through (deny-by-default)', () => {
    // Falsifies a blacklist: a key invented by a future codex release, or one the
    // banned list simply forgot, must not survive by default.
    const { toml, kept, dropped } = projectCodexConfig(
      'model = "m"\nsome_future_switch = "on"\n[some_future_table]\nx = 1\n',
      POSTURE
    );

    expect(toml).not.toContain('some_future_switch');
    expect(toml).not.toContain('some_future_table');
    expect(kept).toEqual(['model']);
    expect(dropped).toEqual(expect.arrayContaining(['some_future_switch', 'some_future_table']));
  });

  it('matches root keys exactly, so `model_reasoning_effort` is not a `model` prefix hit', () => {
    // Falsifies a `startsWith('model')` allowlist, which would also drag in
    // `model_reasoning_effort`, `model_verbosity`, `model_max_output_tokens`…
    const { toml, dropped } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    expect(toml).not.toContain('model_reasoning_effort');
    expect(dropped).toContain('model_reasoning_effort');
  });

  it('does not leak the continuation lines of a triple-quoted block', () => {
    // Falsifies the naive line filter: it drops the `developer_instructions =`
    // line itself but then re-parses `model = "leaked-from-instructions"` inside
    // the block as a root assignment — which would OVERRIDE the real model.
    const { toml } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    expect(toml).not.toContain('leaked-from-instructions');
    expect(toml).not.toContain('Never touch code');
    expect(toml).not.toContain('"""');
    expect(toml.match(/^model = /gm)).toHaveLength(1);
  });

  it('drops a multi-line value even under an allowed table, emitting no orphan lines', () => {
    // Falsifies "allowlisted key ⇒ copy the line": a multi-line array under
    // `model_providers` would leave a dangling `"b",` / `]` in the output and
    // make the file unparseable — i.e. break EVERY session, not just this key.
    const source = `[model_providers.p]
base_url = "https://ok.invalid/v1"
query_params = [
  "a",
  "b",
]
wire_api = "responses"
`;
    const { toml, kept, dropped } = projectCodexConfig(source, POSTURE);

    expect(kept).toEqual(['model_providers.p.base_url', 'model_providers.p.wire_api']);
    expect(dropped).toContain('model_providers.p.query_params');
    expect(toml).not.toContain('query_params');
    expect(toml).not.toContain('"a"');
    for (const line of bodyLines(toml)) {
      expect(line).toMatch(/^(\[[^\]]+\]|[^=]+ = .+)$/);
    }
  });

  it('keeps deny-by-default alive under a garbled table header', () => {
    // Falsifies "unparseable header ⇒ fall back to root scope", which would judge
    // the keys below it as ROOT keys and let `model` through from inside a
    // section the user meant to be `[mcp_servers.x]`.
    const { toml, kept } = projectCodexConfig(
      '[mcp_servers."broken\nmodel = "from-broken-scope"\n',
      POSTURE
    );

    expect(toml).not.toContain('from-broken-scope');
    expect(kept).toEqual([]);
  });

  it('starts with the generated-file header and ends with a newline', () => {
    // Falsifies a silent hand-off: without the header a user edits this file,
    // sees the edit vanish next session, and files a bug against Codex.
    const { toml } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    expect(toml.startsWith(CODEX_CONFIG_HEADER)).toBe(true);
    expect(CODEX_CONFIG_HEADER).toContain('DO NOT EDIT');
    expect(toml.endsWith('\n')).toBe(true);
  });

  it('projects an absent/empty source into a posture-only config', () => {
    // Falsifies a crash-on-missing-config path: a machine that never ran the
    // codex CLI has no `config.toml`, and that must still produce a valid file.
    // Since 5b the floor is not an EMPTY file but the posture: a home with no
    // `approval_policy` would let codex fall back to its own default on the next
    // resume, which is the hole H9 layer 1 closes.
    const { toml, kept, dropped } = projectCodexConfig('', POSTURE);

    expect(bodyLines(toml)).toEqual([
      `${CODEX_PERMISSION_CONFIG_KEYS.approvalPolicy} = "${POSTURE.approvalPolicy}"`,
      `${CODEX_PERMISSION_CONFIG_KEYS.sandboxMode} = "${POSTURE.sandboxMode}"`,
    ]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('every kept path is justified by one of the two exported allowlists', () => {
    // A structural invariant rather than a sample check: whoever widens the
    // projection has to widen an exported constant, where review can see it.
    const { kept } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    expect([...CODEX_CONFIG_ROOT_ALLOWLIST]).toEqual(['model', 'model_provider']);
    expect([...CODEX_CONFIG_TABLE_ALLOWLIST]).toEqual(['model_providers']);
    for (const path of kept) {
      const head = path.split('.')[0] as string;
      const isRoot =
        !path.includes('.') && (CODEX_CONFIG_ROOT_ALLOWLIST as readonly string[]).includes(path);
      const isTable =
        path.includes('.') && (CODEX_CONFIG_TABLE_ALLOWLIST as readonly string[]).includes(head);
      expect(isRoot || isTable).toBe(true);
    }
  });

  it('ignores comments and comment-only assignments', () => {
    // Falsifies a filter that scans for `key =` anywhere on the line: a
    // commented-out `# sandbox_mode = "danger-full-access"` must stay dead.
    const { toml, kept } = projectCodexConfig(
      '# sandbox_mode = "danger-full-access"\nmodel = "m" # trailing note\n',
      POSTURE
    );

    expect(toml).not.toContain('danger-full-access');
    expect(toml).toContain('model = "m"');
    expect(toml).not.toContain('trailing note');
    expect(kept).toEqual(['model']);
  });
});

/**
 * G8① — H9 layer 1.
 *
 * The failure these falsify is not hypothetical: it is [实测]. A thread started
 * under `never` / `read-only` came back from `thread/resume` as
 * `on-request` / `dangerFullAccess` in a fresh process, because resume re-derives
 * the posture from the CODEX_HOME config instead of from the parameters the
 * thread was created with. A projection that only drops the two keys therefore
 * hands every resumed session whatever posture codex defaults to.
 */
describe('projectCodexConfig writes the session posture (H9 layer 1)', () => {
  it('emits both keys with the runtime constant s values, compared to the constant itself', () => {
    const { toml } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);
    const body = configBody(toml);

    // Equality against `CODEX_PERMISSION_DEFAULT`, never a literal: this is the
    // single-source assertion. Spelling `'on-request'` here would keep passing
    // after `thread/start` and this file had drifted apart, which is the exact
    // state H9 exists to make impossible.
    expect(body).toContain(
      `${CODEX_PERMISSION_CONFIG_KEYS.approvalPolicy} = "${CODEX_PERMISSION_DEFAULT.approvalPolicy}"`
    );
    expect(body).toContain(
      `${CODEX_PERMISSION_CONFIG_KEYS.sandboxMode} = "${CODEX_PERMISSION_DEFAULT.sandboxMode}"`
    );
  });

  it('writes OUR posture even though the source set both keys to something weaker', () => {
    // Falsifies "kept the user's line after all": the source says
    // `approval_policy = "never"` + `sandbox_mode = "danger-full-access"`, i.e.
    // every approval prompt off and the whole disk writable.
    const body = configBody(projectCodexConfig(REALISTIC_SOURCE, POSTURE).toml);
    const assignments = body
      .split('\n')
      .filter((line) => line.startsWith(`${CODEX_PERMISSION_CONFIG_KEYS.approvalPolicy} =`));

    // Exactly one, not two: codex reads the LAST assignment of a duplicated root
    // key, so a projection that appended ours after the user's would look right
    // in a `toContain` assertion and run under theirs.
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toBe(
      `${CODEX_PERMISSION_CONFIG_KEYS.approvalPolicy} = "${CODEX_PERMISSION_DEFAULT.approvalPolicy}"`
    );
    for (const value of BANNED_POSTURE_VALUES) {
      expect(body).not.toContain(`"${value}"`);
    }
  });

  it('puts both keys above every table header, where TOML still reads them as root keys', () => {
    // Falsifies an append-at-the-end implementation: a root assignment written
    // after `[model_providers.thirdparty]` becomes a member of THAT table, so
    // codex would see no posture at all and fall back to its own default —
    // silently, since the file still parses.
    const lines = bodyLines(projectCodexConfig(REALISTIC_SOURCE, POSTURE).toml);
    const firstTable = lines.findIndex((line) => line.startsWith('['));

    expect(firstTable).toBeGreaterThan(0);
    for (const key of Object.values(CODEX_PERMISSION_CONFIG_KEYS)) {
      const at = lines.findIndex((line) => line.startsWith(`${key} =`));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(firstTable);
    }
  });

  it('does not report the enforced keys as kept — `kept` audits the USER s config', () => {
    // Falsifies folding the posture into the audit lists: the log line would then
    // claim the user's `approval_policy` survived the projection, which is the
    // opposite of what happened to it.
    const { kept, dropped } = projectCodexConfig(REALISTIC_SOURCE, POSTURE);

    for (const key of Object.values(CODEX_PERMISSION_CONFIG_KEYS)) {
      expect(kept).not.toContain(key);
      expect(dropped).toContain(key);
    }
  });
});

describe('resolveSourceCodexHome', () => {
  it('prefers CODEX_HOME and otherwise falls back to <home>/.codex', () => {
    // Falsifies a hard-coded `~/.codex`: a user who moved CODEX_HOME would get an
    // empty projection and no credential — i.e. the exact failure this module
    // exists to prevent, reintroduced one level up.
    expect(resolveSourceCodexHome({ CODEX_HOME: '/custom/codex' }, '/home/u')).toBe(
      '/custom/codex'
    );
    expect(resolveSourceCodexHome({}, '/home/u')).toBe('/home/u/.codex');
    expect(resolveSourceCodexHome({ CODEX_HOME: '   ' }, '/home/u')).toBe('/home/u/.codex');
  });
});

describe('ensureCodexHome', () => {
  it('creates the directory, writes the projected config and copies auth.json as 0600', () => {
    // Falsifies a stub that returns a projection without materialising anything,
    // and a copy that leaves the credential world-readable.
    const fs = seededHome();
    const result = ensureCodexHome({
      homeDir: '/data/codex-home',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(fs.dirs.has('/data/codex-home')).toBe(true);
    const config = fs.files.get('/data/codex-home/config.toml');
    expect(config?.data).toBe(result.projection.toml);
    expect(config?.data).toContain('[model_providers.thirdparty]');
    // The materialised file carries the posture, not just the projection's
    // return value: `ensureCodexHome` is the only writer, and a resume reads the
    // FILE.
    expect(configBody(config?.data ?? '')).toContain(
      `${CODEX_PERMISSION_CONFIG_KEYS.sandboxMode} = "${CODEX_PERMISSION_DEFAULT.sandboxMode}"`
    );
    expect(configBody(config?.data ?? '')).not.toContain('danger-full-access');
    expect(result.authCopied).toBe(true);
    expect(fs.files.get('/data/codex-home/auth.json')?.data).toBe(AUTH_SECRET);
    expect(fs.files.get('/data/codex-home/auth.json')?.mode).toBe(0o600);
    expect(fs.chmods).toEqual([{ path: '/data/codex-home/auth.json', mode: 0o600 }]);
  });

  it('is idempotent: a second call rewrites nothing and re-copies nothing', () => {
    // Falsifies unconditional writes. Churning `config.toml`/`auth.json` on every
    // session start races a codex process that is already reading them, and
    // rewrites mtimes that this very function uses as its staleness signal.
    const fs = seededHome();
    const first = ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });
    const writesAfterFirst = [...fs.writes];
    const second = ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(first.authCopied).toBe(true);
    expect(second.authCopied).toBe(false);
    expect(fs.writes).toEqual(writesAfterFirst);
    expect(fs.copies).toHaveLength(1);
    expect(second.projection.toml).toBe(first.projection.toml);
  });

  it('rewrites the config when the source config changed', () => {
    // Falsifies "exists ⇒ skip": the user switching provider would keep getting
    // the stale projection forever.
    const fs = seededHome();
    ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });
    fs.files.set('/src/.codex/config.toml', {
      data: 'model = "gpt-6"\nmodel_provider = "other"\n',
      mode: null,
      mtimeMs: 3_000,
    });
    ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(fs.files.get('/data/h/config.toml')?.data).toContain('model = "gpt-6"');
    expect(fs.writes.filter((path) => path === '/data/h/config.toml')).toHaveLength(2);
  });

  it('re-copies auth.json when the source is newer (credential rotation)', () => {
    // Falsifies a copy-once implementation: after the user rotates
    // `~/.codex/auth.json` our copy is a stale credential that still looks valid.
    const fs = seededHome();
    ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });
    fs.files.set('/src/.codex/auth.json', { data: '{"rotated":true}', mode: null, mtimeMs: 9_000 });
    const result = ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(result.authCopied).toBe(true);
    expect(fs.copies).toHaveLength(2);
    expect(fs.files.get('/data/h/auth.json')?.data).toBe('{"rotated":true}');
  });

  it('reports authCopied:false without throwing when the source auth.json is missing', () => {
    // Falsifies a throw: "not signed in yet" (or an API-key-only setup) must
    // still produce a usable home, with the caller left to decide.
    const fs = createFakeFs({ '/src/.codex/config.toml': { data: REALISTIC_SOURCE } });
    const result = ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(result.authCopied).toBe(false);
    expect(fs.copies).toEqual([]);
    expect(fs.files.has('/data/h/config.toml')).toBe(true);
  });

  it('works when the source home does not exist at all', () => {
    // Falsifies "readFileSync on a missing config kills the session": a fresh
    // machine has neither file, and the home must still come out valid.
    const fs = createFakeFs();
    const result = ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/nope',
      fs,
      log: () => {},
    });

    expect(result.authCopied).toBe(false);
    expect(result.projection.kept).toEqual([]);
    expect(fs.files.get('/data/h/config.toml')?.data).toBe(result.projection.toml);
  });

  it('logs paths and key names only — never file content', () => {
    // T-35. Falsifies a debug line that dumps the projected TOML or the copied
    // credential; either would put a `base_url`/token into stderr, and
    // `session.stderr` is forwarded to the renderer.
    const fs = seededHome();
    const calls: unknown[][] = [];
    ensureCodexHome({
      homeDir: '/data/h',
      permission: POSTURE,
      sourceHomeDir: '/src/.codex',
      fs,
      log: (...args) => calls.push(args),
    });
    const logged = JSON.stringify(calls);

    expect(calls.length).toBeGreaterThan(0);
    expect(logged).toContain('/data/h');
    expect(logged).toContain('sandbox_mode'); // the dropped KEY name is fine…
    expect(logged).not.toContain('danger-full-access'); // …its VALUE is not
    expect(logged).not.toContain('sk-live');
    expect(logged).not.toContain('proxy.invalid');
    expect(logged).not.toContain('Never touch code');
    expect(logged).not.toContain('gpt-5.6-sol');
  });

  it('refuses an empty homeDir instead of inventing a default', () => {
    // Falsifies a fallback such as `os.tmpdir()`: Main owns this path
    // (AICLIENT_CODEX_HOME = <userData>/codex-home), and a guessed one would
    // scatter credential copies where no cleanup or audit ever looks.
    const fs = createFakeFs();

    expect(() =>
      ensureCodexHome({ homeDir: '   ', permission: POSTURE, fs, log: () => {} })
    ).toThrow(/homeDir/);
    expect(fs.dirs.size).toBe(0);
  });
});
