import { describe, expect, it } from 'vitest';
import {
  CODEX_CONFIG_HEADER,
  CODEX_CONFIG_ROOT_ALLOWLIST,
  CODEX_CONFIG_TABLE_ALLOWLIST,
  type CodexHomeFs,
  ensureCodexHome,
  projectCodexConfig,
  resolveSourceCodexHome,
} from '../codexHome.ts';

/**
 * The single most important property under test is NEGATIVE: nothing outside the
 * allowlist may reach the generated config. Every `it` below names what it
 * falsifies, because a projection test that only checks "the good keys survived"
 * passes just as happily on a straight file copy.
 */

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

const BANNED = [
  'developer_instructions',
  'approval_policy',
  'sandbox_mode',
  'mcp_servers',
  'notify',
  'profiles',
  'projects',
  'history',
] as const;

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
    const { toml, kept } = projectCodexConfig(REALISTIC_SOURCE);

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
    const { toml, dropped } = projectCodexConfig(REALISTIC_SOURCE);
    const body = configBody(toml);

    for (const banned of BANNED) {
      expect(body).not.toContain(banned);
      expect(wasDropped(dropped, banned)).toBe(true);
    }
    expect(body).not.toContain('danger-full-access');
    expect(body).not.toContain('save-all');
  });

  it('drops unknown keys instead of passing them through (deny-by-default)', () => {
    // Falsifies a blacklist: a key invented by a future codex release, or one the
    // banned list simply forgot, must not survive by default.
    const { toml, kept, dropped } = projectCodexConfig(
      'model = "m"\nsome_future_switch = "on"\n[some_future_table]\nx = 1\n'
    );

    expect(toml).not.toContain('some_future_switch');
    expect(toml).not.toContain('some_future_table');
    expect(kept).toEqual(['model']);
    expect(dropped).toEqual(expect.arrayContaining(['some_future_switch', 'some_future_table']));
  });

  it('matches root keys exactly, so `model_reasoning_effort` is not a `model` prefix hit', () => {
    // Falsifies a `startsWith('model')` allowlist, which would also drag in
    // `model_reasoning_effort`, `model_verbosity`, `model_max_output_tokens`…
    const { toml, dropped } = projectCodexConfig(REALISTIC_SOURCE);

    expect(toml).not.toContain('model_reasoning_effort');
    expect(dropped).toContain('model_reasoning_effort');
  });

  it('does not leak the continuation lines of a triple-quoted block', () => {
    // Falsifies the naive line filter: it drops the `developer_instructions =`
    // line itself but then re-parses `model = "leaked-from-instructions"` inside
    // the block as a root assignment — which would OVERRIDE the real model.
    const { toml } = projectCodexConfig(REALISTIC_SOURCE);

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
    const { toml, kept, dropped } = projectCodexConfig(source);

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
      '[mcp_servers."broken\nmodel = "from-broken-scope"\n'
    );

    expect(toml).not.toContain('from-broken-scope');
    expect(kept).toEqual([]);
  });

  it('starts with the generated-file header and ends with a newline', () => {
    // Falsifies a silent hand-off: without the header a user edits this file,
    // sees the edit vanish next session, and files a bug against Codex.
    const { toml } = projectCodexConfig(REALISTIC_SOURCE);

    expect(toml.startsWith(CODEX_CONFIG_HEADER)).toBe(true);
    expect(CODEX_CONFIG_HEADER).toContain('DO NOT EDIT');
    expect(toml.endsWith('\n')).toBe(true);
  });

  it('projects an absent/empty source into a header-only config', () => {
    // Falsifies a crash-on-missing-config path: a machine that never ran the
    // codex CLI has no `config.toml`, and that must still produce a valid file.
    const { toml, kept, dropped } = projectCodexConfig('');

    expect(bodyLines(toml)).toEqual([]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('every kept path is justified by one of the two exported allowlists', () => {
    // A structural invariant rather than a sample check: whoever widens the
    // projection has to widen an exported constant, where review can see it.
    const { kept } = projectCodexConfig(REALISTIC_SOURCE);

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
      '# sandbox_mode = "danger-full-access"\nmodel = "m" # trailing note\n'
    );

    expect(toml).not.toContain('danger-full-access');
    expect(toml).toContain('model = "m"');
    expect(toml).not.toContain('trailing note');
    expect(kept).toEqual(['model']);
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
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });

    expect(fs.dirs.has('/data/codex-home')).toBe(true);
    const config = fs.files.get('/data/codex-home/config.toml');
    expect(config?.data).toBe(result.projection.toml);
    expect(config?.data).toContain('[model_providers.thirdparty]');
    expect(configBody(config?.data ?? '')).not.toContain('sandbox_mode');
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
      sourceHomeDir: '/src/.codex',
      fs,
      log: () => {},
    });
    const writesAfterFirst = [...fs.writes];
    const second = ensureCodexHome({
      homeDir: '/data/h',
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
    ensureCodexHome({ homeDir: '/data/h', sourceHomeDir: '/src/.codex', fs, log: () => {} });
    fs.files.set('/src/.codex/config.toml', {
      data: 'model = "gpt-6"\nmodel_provider = "other"\n',
      mode: null,
      mtimeMs: 3_000,
    });
    ensureCodexHome({ homeDir: '/data/h', sourceHomeDir: '/src/.codex', fs, log: () => {} });

    expect(fs.files.get('/data/h/config.toml')?.data).toContain('model = "gpt-6"');
    expect(fs.writes.filter((path) => path === '/data/h/config.toml')).toHaveLength(2);
  });

  it('re-copies auth.json when the source is newer (credential rotation)', () => {
    // Falsifies a copy-once implementation: after the user rotates
    // `~/.codex/auth.json` our copy is a stale credential that still looks valid.
    const fs = seededHome();
    ensureCodexHome({ homeDir: '/data/h', sourceHomeDir: '/src/.codex', fs, log: () => {} });
    fs.files.set('/src/.codex/auth.json', { data: '{"rotated":true}', mode: null, mtimeMs: 9_000 });
    const result = ensureCodexHome({
      homeDir: '/data/h',
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

    expect(() => ensureCodexHome({ homeDir: '   ', fs, log: () => {} })).toThrow(/homeDir/);
    expect(fs.dirs.size).toBe(0);
  });
});
