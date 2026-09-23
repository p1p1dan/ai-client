/**
 * Which release the updater actually picks, driven through electron-updater's
 * REAL `GitHubProvider` rather than a mock of it.
 *
 * ## The defect this pins (2026-09-23, field report)
 *
 * `1.0.0-test.20` showed 「检查失败: No published versions on GitHub」 while
 * v1.0.1 was published, latest, public, and carrying a valid `latest.yml`.
 * Nothing was wrong with the release.
 *
 * `AppUpdater`'s constructor derives the channel from the RUNNING version's own
 * prerelease component:
 *
 *   this.allowPrerelease = hasPrereleaseComponents(currentVersion)   // :218
 *
 * so a `1.0.0-test.20` build sets it `true`, and `GitHubProvider` then walks the
 * releases feed matching each tag's prerelease component against its own:
 *
 *   const currentChannel = semver.prerelease(currentVersion)?.[0]    // "test"
 *   const isNextPreRelease = hrefChannel && hrefChannel === currentChannel
 *
 * No tag is spelled `*-test.*`, so `tag` stays null and the provider throws
 * `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. Every `1.0.0-test.*` package hit this
 * identically, which is why none of them ever saw 1.0.1.
 *
 * ## Why this test drives the real provider
 *
 * `AutoUpdater.test.ts` mocks electron-updater, so it can only assert that
 * `init` SET the flag. That would stay green through a future electron-updater
 * upgrade that moved the decision elsewhere — the exact failure mode that made
 * this bug invisible in the first place. Here the provider is real and only the
 * two things it cannot reach from a unit test (the feed and the network
 * executor) are substituted, so the assertions below fail if upstream changes
 * how it picks a tag, or if our pin is dropped.
 *
 * ## `allowPrerelease` is asserted by OUTCOME, not by name
 *
 * The two `1.0.0-test.20` cases differ only in that flag, so the pair IS the
 * proof: `true` reproduces the reported error, `false` resolves v1.0.1. Nothing
 * here reads electron-updater's private fields.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** electron-updater ships CJS and exposes no ESM entry for the provider. */
const providerPath = path.join(
  path.dirname(require.resolve('electron-updater/package.json')),
  'out',
  'providers',
  'GitHubProvider.js'
);

interface ProviderInfo {
  tag: string;
  version: string;
}

interface TestProvider {
  getLatestVersion(): Promise<ProviderInfo>;
  httpRequest?: (url: unknown, headers?: unknown, token?: unknown) => Promise<string>;
}

type ProviderConstructor = new (
  options: { provider: string; owner: string; repo: string; releaseType: string },
  updater: {
    currentVersion: unknown;
    allowPrerelease: boolean;
    channel: null;
    fullChangelog: boolean;
    requestHeaders: null;
  },
  runtimeOptions: {
    isUseMultipleRangeRequest: boolean;
    executor: { request: () => Promise<string> };
    cancellationToken: unknown;
  }
) => TestProvider;

/** The releases feed as GitHub serves it: published releases only, newest first. */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.0.1"/><title>1.0.1</title></entry>
  <entry><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v0.3.4"/><title>0.3.4</title></entry>
</feed>`;

/** What electron-builder wrote into v1.0.1's release. */
const LATEST_YML = [
  'version: 1.0.1',
  'files:',
  '  - url: pilab-v1.0.1-Setup.exe',
  '    sha512: a',
  'path: pilab-v1.0.1-Setup.exe',
  'sha512: a',
  "releaseDate: '2026-09-23T09:30:33.222Z'",
  '',
].join('\n');

function makeProvider(currentVersion: string, allowPrerelease: boolean): TestProvider {
  const { GitHubProvider } = require(providerPath) as { GitHubProvider: ProviderConstructor };
  const semver = require('semver') as { parse(version: string): unknown };

  const provider = new GitHubProvider(
    { provider: 'github', owner: 'o', repo: 'r', releaseType: 'draft' },
    {
      currentVersion: semver.parse(currentVersion),
      allowPrerelease,
      channel: null,
      fullChangelog: false,
      requestHeaders: null,
    },
    {
      isUseMultipleRangeRequest: false,
      executor: { request: async () => LATEST_YML },
      cancellationToken: {},
    }
  );

  // Only the network is substituted; every branch of the tag selection is real.
  provider.httpRequest = async (url: unknown) => {
    const href = String(url);
    if (href.endsWith('/releases.atom')) return FEED;
    if (href.includes('/releases/latest')) return JSON.stringify({ tag_name: 'v1.0.1' });
    throw new Error(`unexpected request: ${href}`);
  };
  return provider;
}

describe('the updater reaches a published release from every shipping version', () => {
  it('a 1.0.0-test.* build resolves v1.0.1 once the channel is pinned stable', async () => {
    await expect(makeProvider('1.0.0-test.20', false).getLatestVersion()).resolves.toMatchObject({
      tag: 'v1.0.1',
      version: '1.0.1',
    });
  });

  it('the same build with its own derived channel still reproduces the reported error', async () => {
    // The negative half, and the reason the pin above is load-bearing: without
    // it electron-updater's own default for this version is `true`, and the
    // exact error the user saw comes back.
    await expect(makeProvider('1.0.0-test.20', true).getLatestVersion()).rejects.toMatchObject({
      code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
      message: 'No published versions on GitHub',
    });
  });

  it('a stable build resolves v1.0.1 too, so the pin changes nothing for it', async () => {
    for (const stable of ['0.3.4', '1.0.1']) {
      await expect(makeProvider(stable, false).getLatestVersion()).resolves.toMatchObject({
        tag: 'v1.0.1',
        version: '1.0.1',
      });
    }
  });
});
