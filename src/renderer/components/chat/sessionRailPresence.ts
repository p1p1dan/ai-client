/**
 * Layout 5e (ui-cohesion §6, ruling L5): whether the session rail is on screen
 * beside this chat. The shell provides it (derived per render, never stored);
 * the composer hides what the rail already shows — the context chip and the
 * run location under the box, the todo strip above it — while it is.
 *
 * Outside the shell (tests, any other host) there is no rail: `false`.
 */
import { createContext, useContext } from 'react';

export const SessionRailPresenceContext = createContext(false);

export function useSessionRailPresent(): boolean {
  return useContext(SessionRailPresenceContext);
}
