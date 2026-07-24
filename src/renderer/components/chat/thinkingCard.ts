import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';

/**
 * T-04 Thinking 折叠卡 view-model 纯函数。
 *
 * 团队轨道红线（chatSessions.ts 属 Claude 主线）只在 Host
 * `capabilities.thinking !== false` 时才会真正出现 thinking 块
 * （capability=false 时 Host 不发 `thinking.started`/`thinking.delta`）；
 * 但 UI 仍守一道门：调用方传 `enabled=false` 直接不渲染。
 *
 * 在途判定：thinking 块是消息最后一块 **且** 当前 session status 指示
 * 正在跑一轮（running/starting），即视为 streaming；否则 done（可展开）。
 * 当后续 tool/text 块已抵达或回合结束（idle/failed/completed 等），自然
 * 切到 done，无需 store 里补 thinking.completed 处理（store 是红线不动）。
 *
 * §12 验证先行：thinkingCard.test.ts 覆盖。
 */
export interface ThinkingCardViewModel {
  /** 'streaming' 显示轻量指示 + 折叠；'done' 显示 header 折叠 + 可展开正文。 */
  state: 'streaming' | 'done';
  /** 原始 thinking 文本（在 streaming 期间持续追加）。 */
  text: string;
}

export function deriveThinkingCard(
  message: ChatMessage,
  blockIndex: number,
  isActiveTurn: boolean
): ThinkingCardViewModel | null {
  const block: ChatBlock | undefined = message.blocks[blockIndex];
  if (!block || block.type !== 'thinking') return null;
  const isLast = blockIndex === message.blocks.length - 1;
  return {
    state: isActiveTurn && isLast ? 'streaming' : 'done',
    text: block.text ?? '',
  };
}

/** 正在跑一轮的 Session status 子集（其他视为回合结束或非流式）。 */
export function isTurnActive(status: string): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * 能力闸：capability.flag 缺省（老 Host 或尚未 host.ready）按"开启"渲染
 * （C-05 default on 口径）；显式 `thinking=false` 才隐藏入口。
 * 用 `!== false` 既覆盖 `undefined`（未知），又覆盖 `true`。
 */
export function isThinkingCapable(capabilities: { thinking?: boolean } | undefined): boolean {
  return capabilities?.thinking !== false;
}
