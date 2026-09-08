import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONBOARDING_SERVICE_URL,
  findCredentialKeys,
  MODEL_CONFIG_PATH,
  parseArgs,
  resolveEndpointUrl,
  SNAPSHOT_RELATIVE_PATH,
  screenSnapshot,
} from '../refresh-model-catalog.mjs';

/**
 * A3 — the release script that owns the bundled catalog snapshot, plus static
 * checks on the file it writes.
 *
 * The full schema gate is the TypeScript `validatePiManagedModelsConfig`, which
 * `src/main/services/piModelConfig/__tests__/catalogSnapshot.test.ts` runs
 * against the checked-in file. What is covered here is the pre-flight that has
 * to fail BEFORE a fetched catalog reaches the working tree, and the packaging
 * wiring that would otherwise leave the snapshot in the repository only.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshotText = readFileSync(path.join(repoRoot, SNAPSHOT_RELATIVE_PATH), 'utf8');
const builderYml = yaml.load(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'));

const VALID = {
  version: 1,
  providers: {
    dan: {
      api: 'openai-responses',
      credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
      models: [{ id: 'deepseek-v4' }],
    },
  },
};

describe('refresh-model-catalog — argument handling', () => {
  it('accepts both `--flag value` and `--flag=value`', () => {
    expect(parseArgs(['--api-key', 'k', '--url', 'https://e/x'])).toEqual({
      dryRun: false,
      apiKey: 'k',
      url: 'https://e/x',
    });
    expect(parseArgs(['--api-key=k', '--dry-run'])).toEqual({ dryRun: true, apiKey: 'k' });
  });

  it('refuses an argument it does not understand', () => {
    // A typo in a release step must stop the step, not silently fetch from the
    // default endpoint and overwrite the snapshot.
    expect(() => parseArgs(['--apikey', 'k'])).toThrow(/unknown argument/);
  });

  it('defaults to this build’s onboarding service and honours the client’s own env var', () => {
    expect(resolveEndpointUrl(undefined, {})).toBe(
      `${DEFAULT_ONBOARDING_SERVICE_URL}${MODEL_CONFIG_PATH}`
    );
    expect(resolveEndpointUrl(undefined, { PILAB_MODEL_CONFIG_URL: 'https://staging/x' })).toBe(
      'https://staging/x'
    );
    // An explicit flag outranks the environment.
    expect(resolveEndpointUrl('https://flag/x', { PILAB_MODEL_CONFIG_URL: 'https://env/x' })).toBe(
      'https://flag/x'
    );
  });

  it('keeps its endpoint constants in step with the client’s', () => {
    const shared = readFileSync(path.join(repoRoot, 'src', 'shared', 'piModelConfig.ts'), 'utf8');
    expect(shared).toContain(`PI_MODEL_CONFIG_PATH = '${MODEL_CONFIG_PATH}'`);
    const serviceUrl = readFileSync(
      path.join(repoRoot, 'src', 'main', 'services', 'onboarding', 'serviceUrl.ts'),
      'utf8'
    );
    expect(serviceUrl).toContain(DEFAULT_ONBOARDING_SERVICE_URL);
  });
});

describe('refresh-model-catalog — pre-flight screening', () => {
  it('passes a well-formed catalog', () => {
    expect(screenSnapshot(VALID)).toEqual([]);
  });

  it('refuses to write a catalog carrying credential-shaped keys', () => {
    // The decisive check: the snapshot ships world-readable inside the package,
    // so a key must never reach the working tree, let alone a release commit.
    const problems = screenSnapshot({
      ...VALID,
      providers: { dan: { ...VALID.providers.dan, apiKey: 'sk-live-should-never-ship' } },
    });
    expect(problems.join(' ')).toContain('$.providers.dan.apiKey');
  });

  it('finds credential keys however deeply they are nested', () => {
    expect(findCredentialKeys({ a: [{ b: { token: 1 } }] })).toEqual(['$.a[0].b.token']);
    expect(findCredentialKeys({ headers: { 'User-Agent': '$VAR' } })).toEqual([]);
  });

  it('does not mistake a D01 credential SOURCE for a credential', () => {
    // `credentials: { baseUrl, apiKey }` names where each value comes from and
    // is present on every provider a current management endpoint serves. A
    // scanner that rejected those would be a scanner nobody could leave on.
    expect(
      findCredentialKeys({ credentials: { baseUrl: 'onboarding', apiKey: 'managed' } })
    ).toEqual([]);
    // The real key sits beside that block, not inside it, and is still caught.
    expect(findCredentialKeys({ credentials: { apiKey: 'managed' }, apiKey: 'sk-live' })).toEqual([
      '$.apiKey',
    ]);
  });

  it('refuses an empty catalog', () => {
    // A zero-model snapshot is read as no snapshot at all, so writing one would
    // quietly disarm the fallback while looking like a successful refresh.
    expect(screenSnapshot({ version: 1, providers: {} })).toContain('catalog carries no models');
    expect(
      screenSnapshot({ version: 1, providers: { dan: { ...VALID.providers.dan, models: [] } } })
    ).toContain('catalog carries no models');
  });

  it('reports every problem in one pass', () => {
    expect(screenSnapshot({ version: 2, providers: { dan: {} } })).toHaveLength(3);
    expect(screenSnapshot('not a catalog')).toEqual(['response is not a JSON object']);
  });
});

describe('the checked-in snapshot', () => {
  it('is valid JSON in the wire shape the client validates', () => {
    const snapshot = JSON.parse(snapshotText);
    expect(snapshot.version).toBe(1);
    expect(typeof snapshot.providers).toBe('object');
  });

  it('carries no credentials', () => {
    // Enforced here as well as in `verify:release`, because this is the check
    // whose failure would be published to every user of the build.
    expect(findCredentialKeys(JSON.parse(snapshotText))).toEqual([]);
  });
});

describe('packaging', () => {
  it('ships the snapshot as an extra resource', () => {
    // Without this entry the snapshot exists only in the repository and a
    // packaged build silently loses its offline catalog.
    expect(builderYml.extraResources).toContainEqual({
      from: SNAPSHOT_RELATIVE_PATH,
      to: 'model-catalog/snapshot.json',
    });
  });

  it('is not wired into dist:prereq', () => {
    // Deliberate: refreshing needs a client API key and a reachable management
    // endpoint, so a build step would fail every offline and CI build on a
    // credential it has no business holding. It is a human release step.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['dist:prereq']).not.toContain('refresh-model-catalog');
    expect(pkg.scripts['refresh:model-catalog']).toBe('node scripts/refresh-model-catalog.mjs');
  });
});
