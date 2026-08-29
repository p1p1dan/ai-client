/**
 * Bundled permission plugin — T08-a.
 *
 * ## What ships and why
 *
 * `@gotgenes/pi-permission-system` (MIT, pinned in `src/agent-host/package.json`)
 * is the extension that gates tool calls behind user approval. It travels inside
 * the app rather than being installed on demand, because "the user happens to
 * have it globally" is not a security posture — on a machine without it, every
 * tool call would run unattended and nothing would say so.
 *
 * ## How it gets loaded
 *
 * Through the SDK's `resourceLoaderOptions.additionalExtensionPaths`, as an
 * ABSOLUTE LOCAL PATH. pi's package manager parses such a path as
 * `{ type: 'local' }` and, for a directory, reads its `package.json` to find the
 * real entry (`pi.extensions: ["./src/index.ts"]`). Three consequences worth
 * stating, because each rules out an approach that looks simpler:
 *
 *  - **A directory, never the file.** The package's `exports` entry is
 *    `src/service.ts` while its pi entry is `src/index.ts`. Resolving the module
 *    would load the wrong one.
 *  - **No network.** A local path is never installed, so this works offline and
 *    on a locked-down machine.
 *  - **The user's `settings.json` is not touched.** Editing someone's global pi
 *    config to make our app work would change their `pi` CLI too.
 *
 * ## What it does with no config
 *
 * Nothing is shipped: no policy file, no defaults. The plugin's own fall-through
 * is `ask` for every surface (`rule.ts`: `defaultAction ?? "ask"`, plus an
 * explicit `origin: "fail-closed"` arm), so a fresh install prompts for
 * everything. That is deliberate and is what makes this task independent of Q9 —
 * choosing which surfaces may default to `allow` is T08-c's job, and until it is
 * decided the safe posture is the one that asks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSION_PLUGIN_PACKAGE = '@gotgenes/pi-permission-system';

/**
 * Where the bundled copy lives, relative to the Host entry.
 *
 * The same shape in dev and packaged, which is why it is a constant rather than
 * two branches: esbuild emits `out-agent-host/piHost.js` beside the pruned
 * `out-agent-host/node_modules/`, and in dev `src/agent-host/piHost.ts` sits
 * beside `src/agent-host/node_modules/`. The pi SDK is already resolved this way
 * (T04) — this is the same sibling-node_modules contract, not a new one.
 */
const BUNDLED_RELATIVE_PATH = ['node_modules', '@gotgenes', 'pi-permission-system'];

/** The directory holding the running Host entry (bundled or TS source). */
function hostDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Absolute path to the bundled plugin directory, or `undefined` when it is not
 * there.
 *
 * Verified by READING `package.json` rather than by `existsSync` on the
 * directory: the build filter is selective about this package (it keeps `.ts`,
 * which the generic rule drops), so a half-copied tree is a real failure mode,
 * and an empty directory would otherwise be reported as a working plugin.
 */
export function resolveBundledPermissionPlugin(baseDir = hostDirectory()): string | undefined {
  const root = join(baseDir, ...BUNDLED_RELATIVE_PATH);
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
    return parsed.name === PERMISSION_PLUGIN_PACKAGE ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does the user's own pi configuration already load this package?
 *
 * If it does we must NOT add ours: pi merges the settings-derived extension list
 * with `additionalExtensionPaths`, and two copies of a permission system means
 * two prompts for every tool call — with the second one arriving after the user
 * has already answered the first.
 *
 * Matching is on the package NAME parsed out of an `npm:` spec, so a pinned
 * `npm:@gotgenes/pi-permission-system@27.0.1` counts as the same package. Local
 * and git sources are matched by substring, which is deliberately generous: the
 * cost of a false positive is running under the user's own copy (fine — they
 * asked for it), while a false negative is the double-prompt above.
 */
export function permissionPluginConfiguredByUser(packages: unknown): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => {
    const source =
      typeof entry === 'string'
        ? entry
        : entry &&
            typeof entry === 'object' &&
            typeof (entry as { source?: unknown }).source === 'string'
          ? (entry as { source: string }).source
          : undefined;
    if (!source) return false;
    if (source.startsWith('npm:')) {
      // Strip the version suffix; the name may itself contain '@' (scope), so
      // the separator is the LAST '@' after the leading scope marker.
      const spec = source.slice('npm:'.length).trim();
      const at = spec.lastIndexOf('@');
      const name = at > 0 ? spec.slice(0, at) : spec;
      return name === PERMISSION_PLUGIN_PACKAGE;
    }
    return source.includes(PERMISSION_PLUGIN_PACKAGE);
  });
}

/** What the runtime learned when it decided whether to inject. */
export interface PermissionPluginDecision {
  /** Pass to `resourceLoaderOptions.additionalExtensionPaths`; empty = nothing to add. */
  additionalExtensionPaths: string[];
  /** Why, for the Host log — a silent permission system is the thing to avoid. */
  reason: 'bundled' | 'user_configured' | 'missing';
}

/**
 * Decide whether to inject the bundled plugin for this session.
 *
 * `missing` is reported rather than thrown. A Host that refuses to start because
 * a plugin is absent leaves the user with no app at all; one that starts and
 * says so leaves them with a working app and a diagnosable gap. The caller logs
 * it — see `piRuntime.ts`.
 */
export function decidePermissionPlugin(
  configuredPackages: unknown,
  baseDir?: string
): PermissionPluginDecision {
  if (permissionPluginConfiguredByUser(configuredPackages)) {
    return { additionalExtensionPaths: [], reason: 'user_configured' };
  }
  const bundled = resolveBundledPermissionPlugin(baseDir);
  return bundled
    ? { additionalExtensionPaths: [bundled], reason: 'bundled' }
    : { additionalExtensionPaths: [], reason: 'missing' };
}
