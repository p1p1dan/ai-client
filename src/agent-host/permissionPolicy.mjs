/**
 * T08-c — the permission policy this app ships with (D-Q9, 2026-08-29).
 *
 * ## Where this ends up, and why there
 *
 * The build writes it to `<bundled plugin>/config.json` inside the artifact.
 * That is the LOWEST-precedence scope `@gotgenes/pi-permission-system` reads
 * (`config-loader.ts` step 2, ahead of the global config), which gives exactly
 * the layering this decision needs:
 *
 *   随包默认 (this file)  <  用户 / 受管 agentDir 配置  <  项目 `.pi/` 配置
 *
 * Three consequences, each of which ruled out an alternative:
 *
 *  - **We never write the user's `~/.pi`.** That directory belongs to their own
 *    `pi` CLI; editing it to make our app behave would change a tool we do not
 *    own. This is the same red line stated in `permissionPlugin.ts`.
 *  - **One source, not two.** Writing a copy into the managed agentDir as well
 *    would create a second place for the policy to live and a sync problem to
 *    get wrong later — the T-CM1 double-cache shape.
 *  - **The user always wins.** Anything they put in their own agentDir config
 *    overrides this wholesale, per surface.
 *
 * ⚠️ The plugin calls that path LEGACY and emits a "move it to …" warning
 * through `ctx.ui.notify`. Today the renderer drops `notify` (T09 is Deferred),
 * so it is invisible; when T09 lands, that warning becomes user-visible advice
 * to move a file inside our own read-only artifact. See the follow-up note in
 * the T08-c decision record.
 *
 * ## Why `.mjs` and not `.json`
 *
 * A policy is a series of judgement calls and each one needs its reason next to
 * it. JSON cannot carry that. The build script and the tests both import this
 * module, so there is still exactly one source of truth.
 *
 * ## The ordering rule that makes or breaks every map below
 *
 * Patterns are LAST-MATCH-WINS. `{ "*.env": "deny", "*": "allow" }` allows
 * `.env`, because `"*"` comes last and matches everything. Every map here
 * therefore starts with its catch-all and narrows downward, and any exception
 * to a deny (`*.env.example`) must come AFTER the deny it carves out of.
 */

/**
 * Files no agent should read, on any surface, in any tool.
 *
 * The `path` surface is cross-cutting and a `path` deny CANNOT be overridden by
 * a per-tool allow — which is what makes `cat *` safe to allow further down.
 * It also covers bash: the plugin extracts path-shaped tokens from the command
 * (including redirect targets), so `cat .env` and `echo x > .env` both land here.
 */
const PATH_RULES = {
  '*': 'allow',
  // Environment files carry secrets by convention; the example template does not.
  // The `.example` exception MUST follow the two denies it carves out of.
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
  // Private keys, wherever they are spelled.
  '~/.ssh/*': 'deny',
  '*.pem': 'deny',
  '*.key': 'deny',
  'id_rsa*': 'deny',
  '~/.aws/credentials': 'deny',
  // Our own credential store. An agent reading this would be reading the
  // company key we injected for it, which is the one file it must never see.
  '~/.pilab/*': 'deny',
};

/**
 * Read-only shell commands that do not need a prompt.
 *
 * Every entry is a command that observes and does not mutate. The dangerous
 * shapes are handled elsewhere and cannot ride these allows:
 *
 *  - `path` denies run BEFORE this, so `cat .env` is blocked, not prompted.
 *  - `external_directory` is `ask`, and most-restrictive-wins, so `ls /etc`
 *    still prompts even though `ls *` is allowed here.
 *  - Wrapper floors clamp `allow` up to `ask` for `sudo`/`xargs`/`find -exec`/
 *    `bash -c`/`eval`, so `find *` cannot become a way to run anything.
 *
 * The `<verb> *` spelling is deliberate: per the plugin's pattern rules a
 * trailing ` *` also matches the bare command, so `git status *` covers both
 * `git status` and `git status --short`.
 */
const BASH_RULES = {
  '*': 'ask',
  // Inspecting the repo's state is what an agent does between every real step;
  // prompting for it is the single biggest source of dialog fatigue.
  'git status *': 'allow',
  'git diff *': 'allow',
  'git log *': 'allow',
  'git show *': 'allow',
  'git branch *': 'allow',
  'git rev-parse *': 'allow',
  // Reading and describing files. Safe because the `path` gate runs first.
  'ls *': 'allow',
  'pwd *': 'allow',
  'cat *': 'allow',
  'head *': 'allow',
  'tail *': 'allow',
  'wc *': 'allow',
  'file *': 'allow',
  'stat *': 'allow',
  // Locating things.
  'which *': 'allow',
  'echo *': 'allow',
  'rg *': 'allow',
  'grep *': 'allow',
  'find *': 'allow',
};

/**
 * MCP: only the discovery calls, which reveal what is connected and nothing else.
 * Anything that actually invokes a server tool prompts.
 */
const MCP_RULES = {
  '*': 'ask',
  mcp_status: 'allow',
  mcp_list: 'allow',
  mcp_search: 'allow',
  mcp_describe: 'allow',
};

/**
 * The shipped default policy — "务实档" (D-Q9 decision 1).
 *
 * The shape of the choice: reading is free, changing is confirmed. An agent
 * that must ask before every `grep` trains the user to approve without reading,
 * which is worse than asking less; an agent that may write without asking
 * removes the last point at which a wrong edit is catchable.
 */
export const AICLIENT_DEFAULT_PERMISSION_POLICY = {
  $schema:
    'https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json',

  debugLog: false,
  // The audit trail for who approved what. On by default in the plugin too;
  // stated explicitly so a future edit has to argue with this line.
  permissionReviewLog: true,
  // Never shipped on. Yolo re-permits even the wrapper floors.
  yoloMode: false,

  permission: {
    // Universal fallback for any surface with no rule of its own — including
    // extension tools this build has never heard of.
    '*': 'ask',
    path: PATH_RULES,
    // Reading and searching: allowed. The `path` denies above still apply.
    read: 'allow',
    grep: 'allow',
    find: 'allow',
    ls: 'allow',
    // Changing the tree: confirmed. NOT `deny` — the plugin's own example uses
    // deny here, which for a coding agent means it cannot do its job at all.
    write: 'ask',
    edit: 'ask',
    bash: BASH_RULES,
    mcp: MCP_RULES,
    skill: { '*': 'ask' },
    // D-Q9 decision 3: leaving the working directory always asks, with no
    // pre-seeded cache allowlist. For a WORKTREE manager this is the boundary
    // that keeps a session in `/repo-a` from reaching into `/repo-b`.
    external_directory: { '*': 'ask' },
  },
};

/** The exact bytes written into the artifact. Trailing newline; two-space indent. */
export function serializeDefaultPermissionPolicy() {
  return `${JSON.stringify(AICLIENT_DEFAULT_PERMISSION_POLICY, null, 2)}\n`;
}
