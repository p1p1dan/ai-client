import { agentDefaultModel } from '@shared/models/chatAgentDefaults';
import { type AgentWireName, sessionAgent } from '@shared/types/agentWire';
import { useCallback } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { resolveResumeModel } from './models';
import { readSessionModel } from './sessionPreferenceStore';

/**
 * D48 S2 — the one place a resume/send call site asks "which model does this
 * session pin", now that the answer needs three inputs instead of one.
 *
 * Before D48 the question was `getSessionModel(id) ?? defaultModelId(host)`, and
 * four call sites (LeftNav, MessageTimeline's Retry, the Context surface,
 * `useMessageMetadata`) each wrote it out. It now needs the session's AGENT
 * (selections are keyed by the pair) and that agent's template, which would put
 * two store reads at each of those four sites — the exact shape F9 extracted
 * `resolveResumeModel` to prevent from drifting.
 *
 * Imperative reads (`getState()`), deliberately: every caller either runs inside
 * an event handler or was already reading non-reactive localStorage during
 * render, so subscribing here would add re-renders without adding freshness.
 * The pure resolution itself stays in `models.ts`, truth-tabled next door.
 */
export function useResolvedSessionModel(): (
  sessionId: string,
  agentOverride?: AgentWireName
) => string | undefined {
  return useCallback((sessionId: string, agentOverride?: AgentWireName) => {
    const session = useChatSessionsStore.getState().sessions.find((item) => item.id === sessionId);
    const agent = agentOverride ?? sessionAgent(session ?? {});
    const defaults = useSettingsStore.getState().chatAgentDefaults;
    return resolveResumeModel(
      readSessionModel,
      sessionId,
      agent,
      agentDefaultModel(defaults, agent)
    );
  }, []);
}
