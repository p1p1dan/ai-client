/**
 * P2-1 — the two prompt segments this phase owns.
 *
 * Provenance (AGENTS.md requires stating it): **adapted** from PI-Desktop's
 * `packages/agent-runtime/src/mode-prompts.ts` (`DEFAULT_RUNTIME_SYSTEM_PROMPT`)
 * and the collaboration block at `runtime.ts:1330`. Product naming and the
 * PI-Desktop-only clauses (BrowserPreview, plan/goal modes, its scratch-dir
 * wording) are dropped; the behavioural rules are kept close to verbatim
 * because they were written against measured failures rather than invented,
 * and rewording them would quietly discard that evidence.
 *
 * Everything here is `static` stability: it contains no session state, so it
 * is byte-identical for every run of a build and forms the cache prefix ARD D9
 * cares about. Anything that needs the cwd, the tier, or the loaded
 * instructions belongs in a later slot, not in this file.
 */

import type { PromptSegment } from './segments.ts';

export const IDENTITY_PROMPT =
  'You are the coding agent inside AI Client, a local-first desktop client for working in a user’s own repositories. Prefer concise, actionable answers, and use the tools available to you when they help.';

/**
 * Collaboration rules.
 *
 * PI-Desktop's comment records why each clause exists: a measured session ran
 * for hours with 380 assistant messages and exactly one non-empty text body,
 * because a reasoning model reads "prefer concise" as "say nothing" and writes
 * its conclusion into thinking, which the user never sees. Every sentence below
 * is one observed failure stated as a rule, so treat edits here as changing an
 * evidence-backed default rather than as wording.
 */
export const COLLABORATION_PROMPT = [
  'Collaboration: answer in the same language the user writes in.',
  'Before each batch of tool calls, write one short sentence saying what you are about to do; never leave the user with no new text for more than one tool batch or 60 seconds of work.',
  'Whatever the user asked must be answered in your visible text — your reasoning is not shown to them, so a conclusion that lives only there never reached them.',
  'Make the final message self-contained: the outcome, what you changed, and anything still open, without asking the user to re-read intermediate updates.',
  'Carry the work through end to end; when you hit a blocker, try to clear it yourself and report what you tried, instead of stopping at analysis or a half-finished change.',
].join(' ');

/**
 * The P2-1 contributions, ready to hand to `composeSystemPrompt`.
 *
 * Returned as a function rather than a frozen constant so a later phase can
 * take an argument (a product name override, for instance) without every
 * caller changing shape.
 */
export function baseSegments(): readonly PromptSegment[] {
  return [
    { slot: 'identity', text: IDENTITY_PROMPT },
    { slot: 'collaboration', text: COLLABORATION_PROMPT },
  ];
}
