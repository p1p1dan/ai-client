/**
 * P2-1 — the system prompt's segment model and its deterministic assembly.
 *
 * The prompt is not a string this runtime owns in one place: identity and
 * collaboration rules are ours (P2-1), tool steering belongs to whoever
 * registers the tools (P1), the skills catalog to P5, the project instruction
 * chain to P2-2. What P2-1 owns is the ORDER those pieces appear in and the
 * guarantee that the order does not depend on who registered first.
 *
 * ## Why a fixed slot table instead of registration order
 *
 * ARD D9 makes the provider-reported cache hit rate a gate, and a provider can
 * only serve a cached prefix when the request's leading bytes are identical to
 * the previous request's. Registration order is decided by Cordis's dependency
 * resolution, which is stable in practice but is not a property we want the
 * cache rate to rest on — a plugin added in P5 could reorder P1's segments and
 * the only symptom would be a slowly worsening hit rate with no failing test.
 * So the order is data ({@link PROMPT_SLOTS}), contributors name a slot, and
 * assembly sorts by the table.
 *
 * The table is additionally ordered by {@link SegmentStability}: everything
 * that never changes within a session comes before anything that can change
 * between turns, so that a mid-session change (mode switch, a reloaded
 * AGENTS.md) invalidates as short a suffix as possible.
 *
 * ## Why unfilled slots are declared rather than omitted
 *
 * `docs/agent-project-engineering.md` A3: a module that contributes nothing
 * must say why. A slot with no contributor yet carries {@link SlotDeferral},
 * and `__tests__/promptSegments.test.ts` fails if one is left without a
 * reason. That keeps "no tool guidance yet" distinguishable from "we forgot
 * tool guidance".
 */

import { RuntimeConfigError } from '../../contracts.ts';

/**
 * How often a slot's text can change, which is what fixes its position.
 *
 * - `static`  — identical for every run of a given build. Safe as a cache prefix.
 * - `session` — fixed once a session is configured (its cwd, its skills, the
 *   instruction files it loaded).
 * - `turn`    — may differ between two turns of one session, because the user
 *   can change it mid-session (ARD D14's mode and permission gear both can).
 */
export type SegmentStability = 'static' | 'session' | 'turn';

export interface SlotDeferral {
  /** Plan-board node that fills it (`docs/plantree/plans/runtime-evolution/README.md`). */
  phase: 'P1' | 'P2-2' | 'P5';
  reason: string;
}

export interface PromptSlotDefinition {
  id: string;
  stability: SegmentStability;
  /** Absent once something contributes to the slot. */
  deferred?: SlotDeferral;
}

/**
 * Every position the system prompt can contain, in the order they are emitted.
 *
 * Adapted from PI-Desktop's assembly (`runtime.ts:1328` builds the base once,
 * `runtime.ts:1503` re-composes base → optional tools → project instructions →
 * mode per turn). Two deliberate differences:
 *
 * 1. The order is declared rather than implied by call site, for the cache
 *    reason in this file's header.
 * 2. ARD D14 splits what this product used to fold into one permission tier
 *    into two axes: the MODE (`plan` / `agent`) decides which tools exist,
 *    the GEAR (`ask` / `accept-edits` / `auto`) decides how much the
 *    remaining calls prompt. Both get a slot, both are P1's to write next to
 *    the policy they describe, and both sit after the instruction chain
 *    because a mode constraint has to outrank a project instruction that
 *    contradicts it — the position PI-Desktop gives its mode block
 *    (`runtime.ts:1506`).
 */
export const PROMPT_SLOTS: readonly PromptSlotDefinition[] = [
  { id: 'identity', stability: 'static' },
  { id: 'collaboration', stability: 'static' },
  {
    id: 'tool-protocol',
    stability: 'static',
    deferred: {
      phase: 'P1',
      reason:
        'the rule "call tools through the native tool-call interface, never as prose" only has meaning once tools are registered; shipping it while the tool array is empty would instruct the model about a capability it does not have.',
    },
  },
  {
    id: 'tool-guidance',
    stability: 'static',
    deferred: {
      phase: 'P1',
      reason:
        'search/edit steering names the concrete tools and their parameters (PI-Desktop steers Read/Grep/Glob away from shell pipelines). The names and parameters are P1-1..P1-4 output, and text that names a tool that does not exist is worse than no text.',
    },
  },
  {
    id: 'skills',
    stability: 'session',
    deferred: {
      phase: 'P5',
      reason:
        'the catalog lists ids the model loads through a Skill tool. Both the loader and that tool are P5-1; a catalog without the tool would advertise an unreachable capability.',
    },
  },
  {
    id: 'project-instructions',
    stability: 'session',
    deferred: {
      phase: 'P2-2',
      reason:
        'CLAUDE.md / AGENTS.md have to be read from disk, and ARD D11 routes every runtime file read through `runtimeHostIo`, which P1-0 lands. Reading them with bare `node:fs` here would be the per-module compatibility patch D11 exists to prevent.',
    },
  },
  {
    id: 'mode',
    stability: 'turn',
    deferred: {
      phase: 'P1',
      reason:
        'ARD D14 defines `plan` (no Write/Edit, bash for inspection, produce a plan for approval) and `agent` (full tool set). The text has to describe the tool set the registry actually hands over in that mode, so it is written with P1-1 rather than ahead of it. Last-but-one position on purpose: a plan-mode constraint must outrank a project instruction that says otherwise.',
    },
  },
  {
    id: 'permission-gear',
    stability: 'turn',
    deferred: {
      phase: 'P1',
      reason:
        'the gear (`ask` / `accept-edits` / `auto`, ARD D14) may not want a segment at all. PI-Desktop keeps the current gear out of any dynamic block and states the rule conditionally inside a static one instead ("...asks for permission unless the effective mode is Auto"), which keeps it inside the cacheable prefix. P1-5 chooses between that and a real segment once it knows what the policy actually prompts on; the slot exists so the choice is recorded rather than made by whoever writes the first string.',
    },
  },
] as const;

export type PromptSlotId = (typeof PROMPT_SLOTS)[number]['id'];

const SLOT_INDEX: ReadonlyMap<string, number> = new Map(
  PROMPT_SLOTS.map((slot, index) => [slot.id, index])
);

export interface PromptSegment {
  slot: string;
  text: string;
}

export interface ComposedSegment {
  slot: string;
  stability: SegmentStability;
  bytes: number;
}

export interface ComposedPrompt {
  text: string;
  /** In emitted order. Blank contributions are absent, not zero-length entries. */
  segments: readonly ComposedSegment[];
  bytes: number;
  /**
   * Byte length of the leading run of `static` segments, separator included.
   *
   * This is the part of the prompt that is identical across every session on a
   * given build, so it is the floor of what a provider could serve from cache.
   * Recorded per run so P2-7's prefix-stability measurement has a number to
   * compare without re-deriving the assembly.
   */
  staticPrefixBytes: number;
}

/** PI-Desktop joins its prompt blocks with a blank line; kept so ported text reads as written. */
const SEPARATOR = '\n\n';

/**
 * Assemble the system prompt from whatever was contributed.
 *
 * Deterministic in the strong sense: the same set of `(slot, text)` pairs
 * produces the same bytes regardless of the order they were passed in.
 * Contributions to unknown slots and two contributions to one slot are both
 * errors rather than best-effort merges — silently concatenating them would
 * make the emitted order depend on caller order again.
 */
export function composeSystemPrompt(contributions: readonly PromptSegment[]): ComposedPrompt {
  const bySlot = new Map<string, string>();
  for (const contribution of contributions) {
    const index = SLOT_INDEX.get(contribution.slot);
    if (index === undefined) {
      throw new RuntimeConfigError(
        'prompt_unknown_slot',
        `no prompt slot named "${contribution.slot}"; add it to PROMPT_SLOTS with a position rather than appending at assembly time`
      );
    }
    if (bySlot.has(contribution.slot)) {
      throw new RuntimeConfigError(
        'prompt_duplicate_slot',
        `prompt slot "${contribution.slot}" was contributed twice; one slot has one owner so its position stays unambiguous`
      );
    }
    bySlot.set(contribution.slot, contribution.text);
  }

  const parts: string[] = [];
  const segments: ComposedSegment[] = [];
  let staticPrefixBytes = 0;
  let staticPrefixOpen = true;
  for (const slot of PROMPT_SLOTS) {
    const raw = bySlot.get(slot.id);
    const text = raw?.trim();
    if (!text) {
      // A slot nobody filled contributes nothing at all, not a blank line: an
      // empty line would still shift every following byte.
      if (slot.stability !== 'static') staticPrefixOpen = false;
      continue;
    }
    const separatorBytes = parts.length === 0 ? 0 : SEPARATOR.length;
    parts.push(text);
    segments.push({ slot: slot.id, stability: slot.stability, bytes: Buffer.byteLength(text) });
    if (staticPrefixOpen && slot.stability === 'static') {
      staticPrefixBytes += separatorBytes + Buffer.byteLength(text);
    } else {
      staticPrefixOpen = false;
    }
  }

  const text = parts.join(SEPARATOR);
  return { text, segments, bytes: Buffer.byteLength(text), staticPrefixBytes };
}

/** Slots with no contributor yet, for the run trace's version stamp (§15). */
export function deferredSlots(): readonly PromptSlotDefinition[] {
  return PROMPT_SLOTS.filter((slot) => slot.deferred !== undefined);
}
