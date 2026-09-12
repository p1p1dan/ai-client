/**
 * P2-5/P2-6 preflight: which configured gateway still serves the suite model.
 *
 * The P2-0 baseline was taken on one gateway; a cache hit rate is mostly a
 * property of that gateway's prompt cache, so the comparison run has to know
 * where the same model lives today before spending real calls. Reads the same
 * `models.json` / `auth.json` the runtime reads and asks each candidate for its
 * model list. Credentials are used as request headers only: nothing derived
 * from them is printed or written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'agent-dir': { type: 'string' },
    'base-url': { type: 'string' },
    provider: { type: 'string', default: 'p2-gateway' },
    model: { type: 'string', default: 'claude-sonnet-5' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '30000' },
  },
});
if (!values['agent-dir'] && !values['base-url']) {
  console.error(
    'usage: node scripts/runtime-baseline/preflight.mjs (--agent-dir DIR | P2_GATEWAY_API_KEY=… --base-url URL) [--model ID]'
  );
  process.exit(2);
}
// An explicitly supplied gateway takes the same shape as a catalog entry, so
// the rest of this script does not care where the candidate came from. The key
// arrives in the environment and is deleted immediately: it must never reach a
// command line, a report field, or an archived artifact.
const explicitKey = process.env.P2_GATEWAY_API_KEY;
delete process.env.P2_GATEWAY_API_KEY;
const agentDir = values['agent-dir'] ? resolve(values['agent-dir']) : null;
const models = agentDir ? JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) : null;
const auth = agentDir
  ? JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))
  : { [values.provider]: explicitKey };
const providers = agentDir
  ? (models.providers ?? models)
  : { [values.provider]: { baseUrl: values['base-url'], models: [] } };

/** auth.json entries are either a bare string or an object holding the secret. */
function secretOf(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  for (const field of ['apiKey', 'key', 'api_key', 'token', 'accessToken']) {
    if (typeof entry[field] === 'string') return entry[field];
  }
  return undefined;
}

const listUrl = (baseUrl) =>
  /\/v\d+$/.test(baseUrl.replace(/\/$/, ''))
    ? `${baseUrl.replace(/\/$/, '')}/models`
    : `${baseUrl.replace(/\/$/, '')}/v1/models`;

const report = {
  agentDir,
  model: values.model,
  checkedAt: new Date().toISOString(),
  results: [],
};
for (const [name, provider] of Object.entries(providers)) {
  const baseUrl = provider.baseUrl ?? provider.base_url;
  const configured = (provider.models ?? []).map((m) => m.id ?? m.name);
  const secret = secretOf(auth[name]);
  const row = {
    provider: name,
    baseUrl,
    api: provider.api,
    configuredModels: configured,
    configuredHasModel: configured.includes(values.model),
    credential: secret ? 'present' : 'missing',
  };
  if (!baseUrl || !secret) {
    row.status = 'skipped';
    report.results.push(row);
    continue;
  }
  try {
    const response = await fetch(listUrl(baseUrl), {
      headers: { Authorization: `Bearer ${secret}`, 'x-api-key': secret },
      signal: AbortSignal.timeout(Number(values.timeout)),
    });
    row.httpStatus = response.status;
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      const ids = (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
      row.servedModelCount = ids.length;
      row.servesModel = ids.includes(values.model);
      row.matchingModels = ids.filter((id) => /claude|sonnet/i.test(id)).slice(0, 12);
      // The whole menu when the wanted model is absent: "not served" is only
      // actionable next to what this gateway does offer.
      if (!row.servesModel) row.servedModels = ids;
    } catch {
      row.bodyExcerpt = text.slice(0, 160);
    }
    row.status = 'checked';
  } catch (error) {
    row.status = 'error';
    row.error = error.message;
  }
  // A gateway may forward a model it does not advertise, so an absent listing
  // is not yet an answer: ask for one token on both wire shapes before
  // concluding the suite model cannot be reached here.
  if (row.status === 'checked' && row.servesModel === false) {
    row.callProbe = {};
    const base = baseUrl.replace(/\/$/, '');
    const root = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    const attempts = [
      [
        'anthropic-messages',
        `${root}/messages`,
        { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
        {
          model: values.model,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        },
      ],
      [
        'openai-completions',
        `${root}/chat/completions`,
        { Authorization: `Bearer ${secret}` },
        {
          model: values.model,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        },
      ],
    ];
    for (const [shape, url, headers, body] of attempts) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Number(values.timeout)),
        });
        const text = await response.text();
        row.callProbe[shape] = { httpStatus: response.status, excerpt: text.slice(0, 200) };
      } catch (error) {
        row.callProbe[shape] = { error: error.message };
      }
    }
  }
  report.results.push(row);
}
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) writeFileSync(resolve(values.out), rendered);
console.log(rendered);
