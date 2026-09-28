/**
 * What Settings → Extensions → Plugins shows (dsh-rebase P1-10c; decisions
 * 108, 110, 115 and 117).
 *
 * Main merges two sources into {@link DshPluginsState}:
 *
 *   catalog  the allowlist as this build ships it — the packaged host's
 *            `dsh-host-manifest.json` `plugins` section, or
 *            `src/dsh-host/plugins/allowlist.json` in a checkout: name,
 *            version, source kind, the gate class of every tool, the review
 *   host     the latest `ready.plugins` report (`getDshPluginReport`), which
 *            says what the host actually composed at its last start
 *
 * and the user's per-plugin overrides (`getDshPluginSelection`). The page
 * writes nothing but one override at a time (`dshPlugins:setEnabled`); there
 * is no install and no removal (decisions 058, 059).
 *
 * Types only: the renderer imports it, Main builds the values.
 */

import type { DshPluginState } from './dshPlugins';

/** One allowlisted plugin as this build ships it. */
export interface DshPluginCatalogEntry {
  name: string;
  /** The allowlisted (exact) version. */
  version: string;
  /** `official`: a `@deepseek-ai/*` package; `internal`: a third-party package this app reviewed. */
  kind: 'official' | 'internal';
  defaultEnabled: boolean;
  /** The package's own description (English); the page prefers its own translated summary. */
  description: string;
  /** Tools the gate treats as reads (decision 047), sorted. */
  readTools: string[];
  /** Tools the gate treats as writes: the page must make these stand out, sorted. */
  writeTools: string[];
  /** Tools listed as "always ask", sorted. */
  askTools: string[];
  /** The allowlist's `'*': 'ask'`: any tool it does not list asks every time. */
  unlistedToolsAsk: boolean;
  /** `null` when the entry carries no usable review record. */
  review: { date: string; verdict: 'approved' | 'conditional' } | null;
}

/** What the host did with one plugin at its last start. */
export interface DshPluginHostStatus {
  state: DshPluginState;
  reason?: string;
  inactiveRows?: string[];
}

export interface DshPluginView extends DshPluginCatalogEntry {
  /** What the next host start asks for: the user's override, else `defaultEnabled`. */
  enabled: boolean;
  /** The user has switched this plugin by hand (it has an entry in `overrides`). */
  overridden: boolean;
  /** `null` until a host start has reported this plugin. */
  host: DshPluginHostStatus | null;
  /**
   * The last host start disagrees with `enabled`: the change waits for the
   * next start (a running host restarts once no session has work in flight,
   * decision 108 rule 7).
   */
  pendingRestart: boolean;
}

/** A plugin the user had on, or the host dropped, that this build no longer ships. */
export interface DshDelistedPlugin {
  name: string;
  /** The host's reason, when its last start reported one. */
  reason: string | null;
}

export interface DshPluginsState {
  /** Every allowlisted plugin, in allowlist order. */
  plugins: DshPluginView[];
  delisted: DshDelistedPlugin[];
  /** A host start has reported plugin states since the app started. */
  hostReported: boolean;
  /** The last host start could not read Main's overrides and enabled nothing (fail closed). */
  selectionInvalid: boolean;
  /** Why the catalog could not be read; `plugins` is then empty. */
  catalogError: string | null;
}

/** `dshPlugins:setEnabled`'s payload. */
export interface SetDshPluginEnabledRequest {
  name: string;
  enabled: boolean;
}
