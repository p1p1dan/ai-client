import type { CometixPinInfo } from '@shared/types/agentHost';

/**
 * Phase 0 pinned Cometix release.
 * Do not bump without re-running Agent SDK + stream-json spikes and updating the Phase 0 report.
 */
export const COMETIX_PIN: CometixPinInfo = {
  name: '@cometix/claude-code',
  version: '2.1.212',
  npmIntegrity:
    'sha512-zpv9fTlhNwmrn4JC96U4kfJrFE7rxwsjzPb359QleS0J65/OFpdHlJUvlrfbCOD8f0npep4t1G6s6KShN5sFEg==',
  tarballSha256: '85c43e15b6ad0a28f7df833724262b100098db76a27c50b212c9e75b6d3ca404',
  tarballUrl: 'https://registry.npmjs.org/@cometix/claude-code/-/claude-code-2.1.212.tgz',
};

/** Claude Agent SDK version used in Phase 0 dual-path spike. */
export const CLAUDE_AGENT_SDK_PIN_VERSION = '0.3.218';
