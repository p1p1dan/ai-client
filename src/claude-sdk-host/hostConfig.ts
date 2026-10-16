/**
 * The SDK host's configuration once Main's key is in (route B S-3, topic
 * s3-project-config.md K-1): the CLI reaches the gateway only through the
 * host's auth proxy, with the proxy's session token as its key. Pure, so the
 * wiring is tested without starting a host (`hostConfig.test.ts`).
 */

import { buildCliEnvironment, buildPinnedSettingsEnv } from './cliEnvironment.ts';
import type { SdkHostConfig } from './sdkSessionRuntime.ts';

export interface HostConfigInput {
  /** The host's own launch environment. */
  inherited: NodeJS.ProcessEnv;
  configDir: string;
  settingSources: SdkHostConfig['settingSources'];
  gitBashPath?: string;
  ripgrepDir?: string;
  /** The gateway key, from Main's first IPC message. */
  apiKey: string;
  proxy: { url: string; token: string };
}

export function buildHostConfig(input: HostConfigInput): {
  config: SdkHostConfig;
  credentialedProxies: string[];
} {
  // What a repository's `.claude/settings.json` `env` may not change (decision 6), the
  // proxy and its token included; never the gateway key.
  const pinned = buildPinnedSettingsEnv({
    inherited: input.inherited,
    baseUrl: input.proxy.url,
    sessionToken: input.proxy.token,
    ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
  });
  return {
    config: {
      configDir: input.configDir,
      settingSources: input.settingSources,
      cliPath: input.inherited.AICLIENT_CLAUDE_SDK_CLI?.trim() || undefined,
      trustRepoPolicy: input.inherited.AICLIENT_CLAUDE_SDK_REPO_POLICY === 'trust',
      ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
      cliEnv: buildCliEnvironment({
        inherited: input.inherited,
        configDir: input.configDir,
        baseUrl: input.proxy.url,
        apiKey: input.proxy.token,
        clientApp:
          input.inherited.AICLIENT_CLAUDE_SDK_CLIENT_APP?.trim() || 'pilab-claude-sdk-proto/0',
        ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
        ...(input.ripgrepDir ? { ripgrepDir: input.ripgrepDir } : {}),
      }),
      settingsEnv: pinned.env,
      secrets: [input.apiKey, input.proxy.token],
    },
    credentialedProxies: pinned.credentialedProxies,
  };
}
