#!/usr/bin/env node
/**
 * A3 — refresh the bundled model catalog snapshot before a release is tagged.
 *
 * Fetches the same `/api/v1/models-config` the client fetches, screens the body,
 * and atomically replaces `resources/model-catalog/snapshot.json`. That file is
 * the offline floor beneath the live catalog: since plan D03 deleted the
 * built-in model table, a first launch, a weak network or a management endpoint
 * that is down otherwise leave the user with an empty model menu.
 *
 * ## This is the ONLY writer
 *
 * ADR 0134 §3: the running application never rewrites the packaged snapshot and
 * never caches a copy in the user's data directory, because a per-machine cache
 * would let two installs of one release run different configurations and the
 * artifact would stop being reproducible. Refreshing is a release step, so it
 * lives in a release script.
 *
 * ## What this script checks, and what it does not
 *
 * The full schema gate is `validatePiManagedModelsConfig` — TypeScript, shared
 * with the client, and re-run against the checked-in file by
 * `scripts/__tests__/model-catalog-snapshot.test.mjs`. Duplicating it here in
 * JavaScript would create a second authority that could drift.
 *
 * What this script owns is the pre-flight that must fail BEFORE anything
 * reaches the working tree: shape, size, model count, and above all the
 * credential scan. A snapshot ships world-readable inside the package, so a
 * provider key in the response must never be written to disk here — the client
 * would reject it at read time, but by then it would already be in a commit.
 *
 * Usage:
 *   node scripts/refresh-model-catalog.mjs --api-key <client key>
 *   node scripts/refresh-model-catalog.mjs --api-key <key> --url <endpoint> --dry-run
 *
 * The key may also come from `PILAB_CLIENT_API_KEY`, and the endpoint from
 * `PILAB_MODEL_CONFIG_URL` — the same variable the client honours.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Kept in step with `PI_MODEL_CONFIG_PATH` and `serviceUrl.ts` by the test. */
export const MODEL_CONFIG_PATH = '/api/v1/models-config';
export const DEFAULT_ONBOARDING_SERVICE_URL = 'https://onboarding-jyw.pipidan.qzz.io';
export const SNAPSHOT_RELATIVE_PATH = 'resources/model-catalog/snapshot.json';

/** Same ceiling the client enforces on a live response. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Keys that must never appear anywhere in a file we are about to commit. */
const CREDENTIAL_KEYS = new Set(['apiKey', 'key', 'token', 'oauth', 'secret', 'password']);

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = inlineValue ?? argv[++index];
    if (flag === '--api-key') args.apiKey = value;
    else if (flag === '--url') args.url = value;
    else if (flag === '--out') args.out = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function resolveEndpointUrl(explicit, env = process.env) {
  const stated = explicit?.trim() || env.PILAB_MODEL_CONFIG_URL?.trim();
  if (stated) return stated;
  const base = (env.PILAB_ONBOARDING_SERVICE_URL?.trim() || DEFAULT_ONBOARDING_SERVICE_URL).replace(
    /\/+$/,
    ''
  );
  return `${base}${MODEL_CONFIG_PATH}`;
}

/**
 * Every path at which a credential-shaped key appears, however deeply nested.
 *
 * Reported as paths rather than as a boolean so a failure names the provider to
 * fix instead of sending the operator to search a 2 MiB document.
 *
 * The `credentials` block is skipped, and that exclusion is the whole subtlety
 * here: since plan D01 every provider states `credentials: { baseUrl, apiKey }`
 * whose values are the enum `'managed' | 'onboarding'` — a declaration of WHERE
 * the value comes from, never the value. Scanning it would reject every real
 * catalog, which is a scanner that gets switched off rather than one that
 * protects anything.
 */
export function findCredentialKeys(value, trail = '$') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findCredentialKeys(item, `${trail}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, childValue]) => {
    if (childKey === 'credentials') return [];
    const childTrail = `${trail}.${childKey}`;
    const here = CREDENTIAL_KEYS.has(childKey) ? [childTrail] : [];
    return [...here, ...findCredentialKeys(childValue, childTrail)];
  });
}

/**
 * The pre-flight. Returns the problems rather than throwing on the first, so a
 * malformed catalog is reported in one pass.
 */
export function screenSnapshot(config) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['response is not a JSON object'];
  }
  if (config.version !== 1)
    problems.push(`version must be 1, got ${JSON.stringify(config.version)}`);
  const providers = config.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    problems.push('providers must be an object');
    return problems;
  }
  let modelCount = 0;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      problems.push(`providers.${providerId} must be an object`);
      continue;
    }
    if (!Array.isArray(provider.models)) {
      problems.push(`providers.${providerId}.models must be an array`);
      continue;
    }
    modelCount += provider.models.length;
  }
  // A zero-model snapshot is not a usable baseline: the reader treats it as no
  // snapshot at all, so writing one would quietly disarm the whole mechanism.
  if (modelCount === 0) problems.push('catalog carries no models');
  const credentials = findCredentialKeys(config);
  if (credentials.length > 0) {
    problems.push(
      `catalog carries credential-shaped keys, which must never be packaged: ${credentials.join(', ')}`
    );
  }
  return problems;
}

/** Same atomic replace the client uses: write a sibling temp file, then rename. */
export function writeSnapshotAtomically(absolutePath, config) {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, absolutePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args.apiKey?.trim() || process.env.PILAB_CLIENT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'a client API key is required (--api-key, or PILAB_CLIENT_API_KEY): the catalog endpoint answers only authenticated clients'
    );
  }
  const endpointUrl = resolveEndpointUrl(args.url);
  const outPath = path.resolve(repoRoot, args.out ?? SNAPSHOT_RELATIVE_PATH);

  console.info(`[model-catalog] fetching ${endpointUrl}`);
  const response = await fetch(endpointUrl, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`management endpoint returned HTTP ${response.status}`);
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('management response exceeds 2 MiB');
  }

  const config = JSON.parse(body);
  const problems = screenSnapshot(config);
  if (problems.length > 0) {
    throw new Error(`refusing to write snapshot:\n  - ${problems.join('\n  - ')}`);
  }

  const providerCount = Object.keys(config.providers).length;
  const modelCount = Object.values(config.providers).reduce(
    (sum, provider) => sum + provider.models.length,
    0
  );
  if (args.dryRun) {
    console.info(
      `[model-catalog] dry run OK — ${providerCount} providers, ${modelCount} models; ${path.relative(repoRoot, outPath)} left untouched`
    );
    return;
  }
  writeSnapshotAtomically(outPath, config);
  console.info(
    `[model-catalog] wrote ${path.relative(repoRoot, outPath)} — ${providerCount} providers, ${modelCount} models`
  );
  console.info('[model-catalog] include this file in the release commit, before tagging');
}

// Only run when invoked directly; the test imports the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[model-catalog] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
