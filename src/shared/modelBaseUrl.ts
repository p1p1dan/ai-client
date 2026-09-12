/**
 * ARD D15 — deriving a provider's `baseUrl` from the wire protocol it speaks.
 *
 * ## The failure this prevents
 *
 * A managed provider that does not carry its own address inherits the one this
 * client logged in with. That is a single string for every provider, and the
 * cch gateway splits its endpoints by model family: the Anthropic side answers
 * at the service root, the OpenAI side only under `/v1`. Handing both families
 * the same inherited URL therefore breaks one of them, and it breaks it as an
 * HTTP 503 `所有供应商暂时不可用` rather than a 404 — indistinguishable, from
 * the client, from the gateway actually being down (P0 live smoke, 2026-09-09).
 *
 * ## Why the suffix is decided here and not taken from the server
 *
 * Because the server's wording is not ours to control, while this rule is
 * testable offline. The escape hatch for a deployment that disagrees is an
 * EXPLICIT address: a provider that states its own `baseUrl` (managed
 * credentials say `baseUrl: 'managed'`) is never rewritten, and neither is a
 * model row that states one. Derivation only fills in what would otherwise be
 * inherited blind.
 *
 * ## Why only three protocols
 *
 * These are the three the gateway serves and the three whose SDK path
 * behaviour we have evidence for:
 *
 *  - Anthropic's SDK appends `/v1/messages`, so its base must NOT carry `/v1`.
 *    pi-ai's own provider table agrees: all ten of its `anthropic-messages`
 *    entries are version-less.
 *  - The OpenAI SDK appends `/chat/completions` or `/responses`, so its base
 *    carries the version segment.
 *
 * Every other style keeps whatever it inherited. Silence is the right answer
 * where we have no evidence: an invented suffix would create exactly the class
 * of failure this module exists to remove.
 */

/** Suffix appended to the service root, per wire protocol. */
const DERIVED_SUFFIX: Readonly<Record<string, string>> = {
  'anthropic-messages': '',
  'openai-completions': '/v1',
  'openai-responses': '/v1',
};

/** Whether {@link deriveInheritedBaseUrl} has a rule for this protocol. */
export function derivesBaseUrl(api: string): boolean {
  return api in DERIVED_SUFFIX;
}

/**
 * Strip the trailing version segment, leaving the address the gateway is
 * reachable at.
 *
 * Only one segment and only at the end: a service whose path genuinely
 * contains `/v1` in the middle (`…/client/v4/accounts/…/ai/v1` style) still
 * gets the same treatment at its tail, which is where the version belongs.
 */
export function serviceRoot(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * The address a provider speaking `api` should be reached at, given the URL it
 * would otherwise inherit verbatim.
 *
 * An empty inherited value stays empty — "no address" is a different condition
 * from "the wrong address", and turning it into a bare `/v1` would produce a
 * request to a relative path instead of a diagnosable missing configuration.
 */
export function deriveInheritedBaseUrl(inherited: string, api: string): string {
  const suffix = DERIVED_SUFFIX[api];
  if (suffix === undefined) return inherited;
  const root = serviceRoot(inherited);
  return root ? `${root}${suffix}` : root;
}

/**
 * Protocols whose SDK supplies the version segment itself, so an address that
 * states one is always wrong.
 *
 * Kept separate from {@link DERIVED_SUFFIX} because the two are used on
 * different inputs. Adding `/v1` is only ever safe for an address this client
 * INHERITED from its own login; a base a person typed may legitimately end in
 * anything (`…/paas/v4`, `https://api.deepseek.com` with no segment at all),
 * and appending to it would break working configurations. Removing a trailing
 * `/v1` from an Anthropic base is the one direction with no counter-example:
 * all ten of pi-ai's `anthropic-messages` providers are version-less.
 */
const VERSIONLESS_APIS = new Set(['anthropic-messages']);

/**
 * Correct an address a person typed, without inventing segments.
 *
 * Applied to user-entered and migrated URLs, where D15 says an explicit value
 * wins — "explicit" meaning the host and path they chose, not a version segment
 * the SDK is about to add a second copy of.
 */
export function stripRedundantVersion(value: string, api: string): string {
  return VERSIONLESS_APIS.has(api) ? serviceRoot(value) : value.trim().replace(/\/+$/, '');
}
