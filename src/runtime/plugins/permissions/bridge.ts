import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
  type PortableExtensionUiBridgeOptions,
} from '../../../agent-host/extensionUiBridge.ts';
import type { PermissionConfig } from './index.ts';

export interface RuntimeApprovalBridge {
  bridge: PortableExtensionUiBridge;
  approve: NonNullable<PermissionConfig['approve']>;
}

export function createRuntimeApprovalBridge(
  options: PortableExtensionUiBridgeOptions
): RuntimeApprovalBridge {
  const bridge = createPortableExtensionUiBridge(options);
  const ui = bridge.uiContext as {
    select(
      title: string,
      values: string[],
      options: { signal: AbortSignal; timeout: number }
    ): Promise<string | undefined>;
  };
  const choices = ['允许一次', '本会话允许此操作', '拒绝'];
  return {
    bridge,
    approve: async (request, signal) => {
      const detail = request.command ?? request.path;
      const selected = await ui.select(`${request.tool}: ${detail.slice(0, 2000)}`, choices, {
        signal,
        timeout: 120_000,
      });
      if (selected === choices[0]) return 'allow-once';
      if (selected === choices[1]) return 'allow-session';
      return 'deny';
    },
  };
}
