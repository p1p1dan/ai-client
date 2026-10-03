/**
 * T08-c — the permission policy this app ships with (D-Q9, 2026-08-29).
 *
 * ## Where this ends up, and why there
 *
 * Nowhere on disk. The DSH permission row and the settings page read it in
 * memory, through `bundledPolicyScope()` in `policy.ts`, as the `bundled` scope
 * below global/project policy (dsh-rebase P1-12, decisions 041 and 147). Until
 * then this file lived in `src/agent-host/` and the worker build wrote it into
 * the pinned pi-permission-system plugin's `config.json`.
 *
 *   随包默认 (this file)  <  用户 / 受管 agentDir 配置  <  项目 `.pi/` 配置
 *
 * Three consequences, each of which ruled out an alternative:
 *
 *  - **We never write the user's `~/.pi`.** That directory belongs to their own
 *    `pi` CLI; editing it to make our app behave would change a tool we do not
 *    own. 1.0.x's permission plugin loader stated the same red line.
 *  - **One source, not two.** Writing a copy into the managed agentDir as well
 *    would create a second place for the policy to live and a sync problem to
 *    get wrong later — the T-CM1 double-cache shape.
 *  - **The user always wins.** Anything they put in their own agentDir config
 *    overrides this wholesale, per surface.
 *
 * ## Why `.mjs` and not `.json`
 *
 * A policy is a series of judgement calls and each one needs its reason next to
 * it. JSON cannot carry that. The permissions library and the tests both import
 * this module, so there is still exactly one source of truth. It stays plain
 * data that imports nothing (`permissionsLibraryBoundaryStatic.test.ts`).
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
  // Broad application-state boundary. This MUST precede narrower secret rules
  // so `.pilab/**/.env`, PEM and key files remain deny under last-match-wins.
  '~/.pilab/*': 'ask',
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
};

// D14: every shell call reaches approval in ask. The session authorizer releases
// workspace bash in accept-edits and auto, after path/external-directory gates.
const BASH_RULES = { '*': 'ask' };

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

  // T025 removed `authorizerChain: ['aiclient-session-tier']` from here. That
  // line named a link registered by an inline pi extension that P6-5 retired
  // along with the legacy engine, so the shipped policy was advertising a
  // chain nothing could join. The tiers it used to implement are now decided
  // by the gate in `src/shared/permissions/` (moved from the self-owned
  // runtime, decision 041), which does not consult a chain at all; deny rules
  // were never chain-dependent and are unaffected.

  permission: {
    // Universal fallback for any surface with no rule of its own — including
    // extension tools this build has never heard of.
    '*': 'ask',
    path: PATH_RULES,
    // Reading and searching: allowed. The `path` denies above still apply.
    // No `ls` entry: native has no `ls` tool (see `ToolsPlugin.install`) and
    // no code path ever queries an `ls` policy surface, so the key had no
    // producer and no reader — T002 removed it rather than ship a rule that
    // looks like protection and does nothing.
    read: 'allow',
    grep: 'allow',
    find: 'allow',
    // Changing the tree: confirmed. NOT `deny` — the plugin's own example uses
    // deny here, which for a coding agent means it cannot do its job at all.
    write: 'ask',
    edit: 'ask',
    bash: BASH_RULES,
    mcp: MCP_RULES,
    skill: { '*': 'ask' },
    // D11 rev.2: ordinary external paths ask. `.pilab` is already asked by the
    // earlier cross-cutting path gate, so allow it here only to avoid a duplicate
    // second prompt; this carve-out never bypasses the path decision.
    external_directory: { '*': 'ask', '~/.pilab/*': 'allow' },
  },
};

/** The exact bytes written into the artifact. Trailing newline; two-space indent. */
export function serializeDefaultPermissionPolicy() {
  return `${JSON.stringify(AICLIENT_DEFAULT_PERMISSION_POLICY, null, 2)}\n`;
}
