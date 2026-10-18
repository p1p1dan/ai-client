/**
 * The SDK host's configuration once Main's key is in (route B S-3, topic
 * s3-project-config.md K-1): the CLI reaches the gateway only through the
 * host's auth proxy, with the proxy's session token as its key. Pure, so the
 * wiring is tested without starting a host (`hostConfig.test.ts`).
 */

import {
  CLAUDE_SDK_MODEL_WINDOWS_ENV,
  parseClaudeSdkModelWindows,
} from '../shared/claudeSdkEngine.ts';
import { childProxyOverlay, type HostProxySetting, hostProxySecrets } from '../shared/hostProxy.ts';
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
  /** Probes only: a stand-in home directory, excluded besides `os.homedir()` (S-3 P-11). */
  homeDir?: string;
  proxy: { url: string; token: string };
  /**
   * Dsh-rebase decision 196: the product proxy as the chat opened (`null`:
   * off; undefined: Main keeps the engines off it). The CLI and every child
   * it starts see it for the schemes the launch environment did not name
   * (rule 7); a later change reaches the auth proxy only.
   */
  outboundProxy?: HostProxySetting | null;
}

export function buildHostConfig(input: HostConfigInput): {
  config: SdkHostConfig;
  credentialedProxies: string[];
} {
  // Decision 196 rule 7: DSH's child rule, so the CLI's own requests (WebFetch, MCP)
  // and its tools route as a DSH tool would.
  const overlay = childProxyOverlay(input.inherited, input.outboundProxy ?? null);
  const inherited: NodeJS.ProcessEnv = { ...input.inherited, ...overlay };
  // What a repository's `.claude/settings.json` `env` may not change (decision 6), the
  // proxy and its token included; never the gateway key.
  const pinned = buildPinnedSettingsEnv({
    inherited,
    baseUrl: input.proxy.url,
    sessionToken: input.proxy.token,
    ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
  });
  // Main's catalog windows for this route (user 2026-10-18); malformed ones are dropped.
  const modelWindows = parseClaudeSdkModelWindows(input.inherited[CLAUDE_SDK_MODEL_WINDOWS_ENV]);
  return {
    config: {
      ...(Object.keys(modelWindows).length > 0 ? { modelWindows } : {}),
      configDir: input.configDir,
      settingSources: input.settingSources,
      cliPath: input.inherited.AICLIENT_CLAUDE_SDK_CLI?.trim() || undefined,
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
      cliEnv: {
        ...buildCliEnvironment({
          inherited,
          configDir: input.configDir,
          baseUrl: input.proxy.url,
          apiKey: input.proxy.token,
          clientApp:
            input.inherited.AICLIENT_CLAUDE_SDK_CLIENT_APP?.trim() || 'pilab-claude-sdk-proto/0',
          ...(input.gitBashPath ? { gitBashPath: input.gitBashPath } : {}),
          ...(input.ripgrepDir ? { ripgrepDir: input.ripgrepDir } : {}),
        }),
        // Not an inherited name: only the product proxy's overlay sets it, as DSH does.
        ...(overlay.NODE_USE_ENV_PROXY ? { NODE_USE_ENV_PROXY: overlay.NODE_USE_ENV_PROXY } : {}),
      },
      settingsEnv: pinned.env,
      secrets: [input.apiKey, input.proxy.token, ...hostProxySecrets(input.outboundProxy)],
    },
    credentialedProxies: pinned.credentialedProxies,
  };
}
