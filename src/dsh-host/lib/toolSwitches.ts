/**
 * dsh-rebase decision 190: the switches of the tool gaps it closes, one per
 * item, so each can be measured on and off (engineering standard §6).
 *
 * - `AICLIENT_RUNTIME_WEB_FETCH`: `0` leaves DSH's web rows off, as before
 *   decision 190, so the model has no `web_fetch`. Read by the `!!js`
 *   `disabled` expressions of bundle/cordis.patch.yml, which a static test
 *   pins to this name.
 * - `AICLIENT_RUNTIME_RICH_GREP`: `0` makes the `aiclient-fs-search` row
 *   register DSH's own three-argument `grep` instead of ours.
 *
 * The third switch, `AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS`, is Main's: it
 * changes the model plan before the host sees it (src/shared/dshModelPlan).
 *
 * Only the exact value `0` turns a gap back on; anything else keeps the new
 * behaviour. Main strips `AICLIENT_*` from the host's environment and
 * forwards these two by name (`FORWARDED_ENV` in
 * src/main/services/agent-host/dshHostEnvironment.ts).
 *
 * Pure and import-free: host.ts logs the state at every start, and the
 * fs-search row reads its switch through `richGrepEnabled`.
 */

export const WEB_FETCH_ENV = 'AICLIENT_RUNTIME_WEB_FETCH';
export const RICH_GREP_ENV = 'AICLIENT_RUNTIME_RICH_GREP';

type Env = Readonly<Record<string, string | undefined>>;

/** Whether the bundle composes `web_fetch` (its rows' `!!js` reads the same rule). */
export function webFetchEnabled(env: Env): boolean {
  return env[WEB_FETCH_ENV] !== '0';
}

/** Whether `aiclient-fs-search` registers our grep rather than DSH's. */
export function richGrepEnabled(env: Env): boolean {
  return env[RICH_GREP_ENV] !== '0';
}

/** The host's start line, e.g. `tool switches: web_fetch on, grep rich`. */
export function describeToolSwitches(env: Env): string {
  const webFetch = webFetchEnabled(env) ? 'on' : `off (${WEB_FETCH_ENV}=0)`;
  const grep = richGrepEnabled(env) ? 'rich' : `dsh (${RICH_GREP_ENV}=0)`;
  return `tool switches: web_fetch ${webFetch}, grep ${grep}`;
}
