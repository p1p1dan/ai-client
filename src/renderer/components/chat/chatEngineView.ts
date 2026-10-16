/**
 * Route B, S-2 (plan topic s2-permission-modes.md A-9): which engine a chat's
 * permission menu, its plan-approval toast and its goal entry speak for.
 *
 * Display only. Main decides the engine when the chat is created and reports
 * it in `session.created` / `session.resumed` (`ChatSession.engine`); the model
 * picker's route filter and everything Main does use that report alone. Before
 * it arrives the menu still has to show one set of names:
 *
 * - a chat Main already bound: its report (absent means DSH);
 * - a chat with a runtime identity (reopened from the index): the session
 *   stub's suffix, the same one Main reopens on (`CLAUDE_SDK_STUB_SUFFIX`);
 * - a chat not started yet: the model the next send carries, through the same
 *   rule Main applies (switch on, the model on an Anthropic-protocol route,
 *   the host in this build, `AgentModelCatalog.claudeSdkHostAvailable`). A
 *   chat whose SDK host then fails to start comes up on DSH, and the names
 *   follow once `session.created` says so.
 */

import { type ChatEngine, CLAUDE_SDK_STUB_SUFFIX } from '@shared/claudeSdkEngine';
import type { AgentModelOption } from '@shared/types/agentCatalog';

/** The engine a chat not started yet will most likely run on. */
export function predictNewChatEngine(input: {
  enabled: boolean;
  /** This build can start the SDK host (`AgentModelCatalog.claudeSdkHostAvailable`). */
  hostAvailable: boolean;
  catalog: readonly AgentModelOption[];
  /** The model the next send carries; undefined is Automatic, the catalog's first. */
  model: string | undefined;
}): ChatEngine {
  if (!input.enabled || !input.hostAvailable) return 'dsh';
  const option = input.model
    ? input.catalog.find((item) => item.id === input.model)
    : input.catalog[0];
  return option?.sdkRoute ? 'claude-sdk' : 'dsh';
}

/** The engine whose names the chat shows. */
export function chatEngineForDisplay(input: {
  /** Main reported the chat (`session.created` / `session.resumed` arrived). */
  bound: boolean;
  engine?: ChatEngine;
  runtimeIdentity?: string;
  predicted: ChatEngine;
}): ChatEngine {
  if (input.bound) return input.engine ?? 'dsh';
  if (input.engine) return input.engine;
  if (input.runtimeIdentity) {
    return input.runtimeIdentity.endsWith(CLAUDE_SDK_STUB_SUFFIX) ? 'claude-sdk' : 'dsh';
  }
  return input.predicted;
}
