/**
 * Credential-shaped samples, shared by every redaction exit's test (T042).
 *
 * The values are obviously fake — a provider prefix followed by a run of `x`
 * or a spelled-out word — so that a leaked sample in a log or a diff is
 * harmless and recognizable as a fixture. Their SHAPE is what matters: each
 * one is the form a real key of that family takes, which is the only handle a
 * redactor has when the secret arrives as prose rather than as an assignment.
 *
 * Both the stderr exit (`redactStderrLine`) and the provider-error exit
 * (`redactSensitiveErrorText`) are asserted against this one table. That is
 * how "there is a single rule set" is verified rather than asserted in a
 * comment: if either exit grows its own private copy of the rules, the copy
 * has to keep up with every row here or the parity case fails.
 */
export interface CredentialSample {
  /** What the exits are asked to mask, in the wording a sink really sees. */
  readonly text: string;
  /** The substring that must not survive. */
  readonly secret: string;
  /** Why this row exists. */
  readonly why: string;
}

const X40 = 'x'.repeat(40);

export const CREDENTIAL_SAMPLES: readonly CredentialSample[] = [
  {
    text: `401 Unauthorized for key sk-ant-api03-${X40}`,
    secret: `sk-ant-api03-${X40}`,
    why: 'bare Anthropic key in prose — no field name for an assignment rule to hook',
  },
  {
    text: `Incorrect API key provided: sk-proj-${X40}`,
    secret: `sk-proj-${X40}`,
    why: 'ah-lib-02 verbatim: "API key" and the colon are separated by a word, so only the shape matches',
  },
  {
    text: `bad credentials: sk-${X40}`,
    secret: `sk-${X40}`,
    why: 'generic long sk- key (OpenAI-compatible gateways)',
  },
  {
    text: 'billing rejected sk_live_xxxxxxxxxxxxxxxx',
    secret: 'sk_live_xxxxxxxxxxxxxxxx',
    why: 'Stripe-style live secret',
  },
  {
    text: 'git push denied for ghp_xxxxxxxxxxxxxxxxxxxx',
    secret: 'ghp_xxxxxxxxxxxxxxxxxxxx',
    why: 'GitHub token — MCP servers and skills shell out to git',
  },
  {
    text: 'Google API error for AIzaxxxxxxxxxxxxxxxxxxxx',
    secret: 'AIzaxxxxxxxxxxxxxxxxxxxx',
    why: 'Google API key',
  },
  {
    text: 'AWS signature mismatch AKIAXXXXXXXXXXXXXXXX',
    secret: 'AKIAXXXXXXXXXXXXXXXX',
    why: 'AWS long-lived access key id',
  },
  {
    text: 'STS session ASIAXXXXXXXXXXXXXXXX expired',
    secret: 'ASIAXXXXXXXXXXXXXXXX',
    why: 'AWS temporary access key id',
  },
  {
    text: `502 upstream body: {"detail":"Authorization: Bearer opaque-${X40}"}`,
    secret: `opaque-${X40}`,
    why: 'the gateway echo in ah-lib-01: a header folded into a JSON error body',
  },
  {
    text: `{"error":"unauthorized","received":{"api_key":"plain-${X40}"}}`,
    secret: `plain-${X40}`,
    why: 'JSON-shaped assignment: quoted name, quoted value',
  },
  {
    text: `env dump: ANTHROPIC_AUTH_TOKEN=plain-${X40}`,
    secret: `plain-${X40}`,
    why: 'env echo on a failed spawn — the stderr case that started all of this',
  },
  {
    text: `proxy error: https://build-user:pw-${X40}@gateway.internal/v1`,
    secret: `pw-${X40}`,
    why: 'credentials in a URL authority, which base-URL echoes reproduce verbatim',
  },
];
