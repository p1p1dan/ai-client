/**
 * The DSH host's profile rules (dsh-rebase P1-3a; decisions 023 and 025).
 *
 * Pure and import-free: host.ts applies them at every start, the unit tests
 * pin them, and the packaged build bundles this file into host.js
 * (scripts/build-dsh-host.mjs).
 */

/** The product bundles, in layer order. Re-asserted at every start (decision 025 rule 5). */
export const PRODUCT_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'];

/**
 * Product bundles an earlier build listed and this one no longer ships. They
 * are dropped from the profile instead of being skipped, which for a product
 * bundle refuses the boot. None yet.
 */
export const RETIRED_PRODUCT_BUNDLES: readonly string[] = [];

/**
 * Rows the composition turns off: the privacy and endpoint rows. host.ts
 * checks them on the composed list and restates them after every user layer
 * (`requiredDisabledOverlays`), so `$DSH_HOME/cordis.patch.yml` cannot turn
 * one back on (decision 023 rule 3).
 */
export const REQUIRED_DISABLED: readonly string[] = [
  'session-telemetry-otel',
  'deepseek-account',
  'llm-deepseek-account',
  'hmr',
  // No row may reach the DeepSeek official endpoint.
  'llm-deepseek',
  'deepseek-llm-api-extensions',
  'plugin-package-inventory-deepseek',
  'session-log-deepseek',
  'web-search-deepseek',
  // P1-5b (decision 034): dsh-credentials-local keeps keys in plain text in
  // $DSH_HOME/.credentials.yaml; aiclient-credentials pulls them from Main.
  'credentials',
  // Decision 082 (closing decisions 016, 058): plugin installs never run on
  // the user's machine; the plugin allowlist ships preinstalled instead.
  'plugin-manager',
  'tool-plugin-manager',
  // P1-6b (decision 047): dsh-permission-presets would be a second gear
  // selector beside ai-client's own (`/permission` and the presets); the
  // aiclient-permissions row is the only one.
  'permission',
];

/**
 * Rows the composition must carry and keep on (host.ts checks them on the
 * composed list). The loop guard and the credentials row are only checked: a
 * layer that turns one off refuses the boot (decisions 065, 034). The
 * encrypted-read row is checked the same way: it is inert outside Windows,
 * and a composition without it would silently lose the P1-13c fallback
 * (decision 091).
 */
export const REQUIRED_ENABLED: readonly string[] = [
  'aiclient-loop-guard',
  'aiclient-credentials',
  'aiclient-permissions',
  'aiclient-encrypted-read',
];

/**
 * Required rows that are also restated on after every user layer, the way
 * `REQUIRED_DISABLED` rows are restated off: ai-client's permission gate
 * (P1-6b, decision 042). A home patch cannot take the approval floor away;
 * the composition check still refuses a bundle that does not carry the row.
 */
export const RESTATED_ENABLED: readonly string[] = ['aiclient-permissions'];

export interface SkippedBundle {
  packageName: string;
  reason: string;
}

/**
 * The profile's bundle list with the product bundles re-asserted: the product
 * bundles first and in order, then every other listed bundle (a plugin, or a
 * probe's test bundle) once and in its existing order; retired product
 * bundles are dropped. Idempotent. `initProfile` writes the list only once, so
 * without this an upgrade that adds, renames or retires a product bundle
 * would keep booting the first install's list.
 */
export function reconcileProductBundles(
  current: unknown,
  product: readonly string[] = PRODUCT_BUNDLES,
  retired: readonly string[] = RETIRED_PRODUCT_BUNDLES
): string[] {
  const reserved = new Set([...product, ...retired]);
  const rest: string[] = [];
  for (const name of Array.isArray(current) ? current : []) {
    if (typeof name !== 'string' || name === '' || reserved.has(name) || rest.includes(name)) {
      continue;
    }
    rest.push(name);
  }
  return [...product, ...rest];
}

export function sameBundles(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Patches restating every required row off. They go last among the launch
 * overlays, after the home layer (`readProfilePatches` order), so no user file
 * can turn a privacy row back on; the composition audit still runs after.
 */
export function requiredDisabledOverlays(): Array<{ id: string; disabled: true }> {
  return REQUIRED_DISABLED.map((id) => ({ id, disabled: true as const }));
}

/** Patches restating `RESTATED_ENABLED` on; they go after `requiredDisabledOverlays()`. */
export function requiredEnabledOverlays(): Array<{ id: string; disabled: false }> {
  return RESTATED_ENABLED.map((id) => ({ id, disabled: false as const }));
}

/**
 * A skipped product bundle refuses the boot; a skipped plugin bundle only
 * warns, so a plugin broken by an upgrade cannot take every chat down with it
 * (decision 025 rule 5).
 */
export function partitionSkippedBundles(
  skipped: readonly SkippedBundle[],
  product: readonly string[] = PRODUCT_BUNDLES
): { product: SkippedBundle[]; plugins: SkippedBundle[] } {
  return {
    product: skipped.filter((bundle) => product.includes(bundle.packageName)),
    plugins: skipped.filter((bundle) => !product.includes(bundle.packageName)),
  };
}

/**
 * dsh-rebase P1-16a (decision 101 rule 1): the same variable P1-6c's
 * permission policy reads as its user layer — `PERMISSION_AGENT_DIR_ENV` in
 * bridge/plugin.ts, `DSH_HOST_PERMISSION_AGENT_DIR_ENV` in
 * src/main/services/agent-host/dshHostEnvironment.ts. One path, one source:
 * host.ts reads this instead of a second delivery channel, so the
 * `agent-instructions` / `skill-filesystem` overlays below and the permission
 * policy's user layer always name the same `<agentDir>`. A static test
 * (hostStatic.test.ts) pins every declaration of the literal equal.
 */
export const AGENT_DIR_ENV = 'AICLIENT_PERMISSION_AGENT_DIR';

/**
 * `dsh-base`'s own `agent-instructions` budget (bundle/cordis.patch.yml).
 * Restated by `agentDirOverlays` because a same-id patch replaces the row's
 * whole `config` (decision 101 rule 2), never merges it.
 */
const AGENT_INSTRUCTIONS_MAX_BYTES = 65536;

/**
 * The `agent-instructions` and `skill-filesystem` overlays that point DSH's
 * own instruction and skill loading at `<agentDir>` (decision 101 rule 2):
 * `dshHome` for the workspace-instruction baseline (`<agentDir>/AGENTS.md`),
 * `customSkillDirs` for the user's skills (`<agentDir>/skills`, rank 300 by
 * `dsh-skill-filesystem`'s own root table). None when the host was handed no
 * path — e.g. the packaged smoke, or a profile started outside Main — so both
 * rows keep DSH's own `$DSH_HOME`-relative defaults unchanged.
 */
export function agentDirOverlays(
  agentDir: string | undefined
): Array<{ id: string; config: Record<string, unknown> }> {
  if (!agentDir) return [];
  return [
    {
      id: 'agent-instructions',
      config: { maxBytes: AGENT_INSTRUCTIONS_MAX_BYTES, dshHome: agentDir },
    },
    { id: 'skill-filesystem', config: { customSkillDirs: [`${agentDir}/skills`] } },
  ];
}
