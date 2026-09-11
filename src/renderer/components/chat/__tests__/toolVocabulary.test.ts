import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_ALLOW,
  PERMISSION_ALLOW_SESSION,
  PERMISSION_ALLOWED,
  PERMISSION_ALLOWED_SESSION,
  PERMISSION_CANCEL,
  PERMISSION_DECISION_LABELS,
  PERMISSION_DENIED,
  PERMISSION_DENIED_STOPPED,
  PERMISSION_DENY,
  PERMISSION_DIFF_CLAMPED_MARK,
  PERMISSION_NO_COMMAND_NOTE,
  PERMISSION_TITLE,
  PERMISSION_WAITING,
} from '../questionCardModel';
import { AGGREGATE_VERB, TOOL_VERBS, UNKNOWN_TOOL_VERB } from '../toolCard';
import { THINKING_VERB, THOUGHT_BRIEF_ARG, THOUGHT_VERB, WORKED_FOR_VERB } from '../turnTiming';

/**
 * The other half of the i18n guard.
 *
 * `i18nCoverage.test.ts` scans for literal `t('…')` calls, which is most of the
 * renderer but structurally cannot be all of it: a tool row's verb travels as a
 * plain string through several pure modules and is translated at the END, with
 * `t(view.verb)` — a call whose key a scanner cannot read. That is a deliberate
 * design (one `t()` covers every row shape; see `ToolRowView.verb`), and it is
 * exactly the shape the 2026-09-11 field report caught in Chinese: Grepped,
 * Ran, Edited, Read, Editing, Thought, Permission, Allow, Deny.
 *
 * So the vocabularies are asserted directly instead. Adding a tool to
 * `TOOL_VERBS` without its three words in the catalog fails here rather than in
 * front of a user.
 */

function expectTranslated(words: readonly string[], what: string) {
  const missing = [...new Set(words)].filter((word) => !(word in zhTranslations)).sort();
  expect(missing, `${what} missing from zhTranslations`).toEqual([]);
}

describe('chat vocabulary is translatable', () => {
  it('every tool verb has a catalog entry', () => {
    const words = Object.values(TOOL_VERBS).flatMap((verbs) => [
      verbs.done,
      verbs.running,
      verbs.refused,
    ]);
    words.push(UNKNOWN_TOOL_VERB.done, UNKNOWN_TOOL_VERB.running, UNKNOWN_TOOL_VERB.refused);
    words.push(AGGREGATE_VERB.done, AGGREGATE_VERB.running);
    expectTranslated(words, 'tool verbs');
  });

  it('the table it checks is the real one, not an empty object', () => {
    // Same guard `i18nCoverage` puts on its own scan: a lookup that silently
    // stopped resolving would make the assertion above pass on nothing.
    expect(Object.keys(TOOL_VERBS).length).toBeGreaterThan(20);
    expect(TOOL_VERBS.Bash?.done).toBe('Ran');
  });

  it('thought and turn-timing words have catalog entries', () => {
    expectTranslated(
      [THOUGHT_VERB, THINKING_VERB, THOUGHT_BRIEF_ARG, WORKED_FOR_VERB],
      'timing words'
    );
  });

  it('permission card words have catalog entries', () => {
    expectTranslated(
      [
        PERMISSION_TITLE,
        PERMISSION_ALLOW,
        PERMISSION_ALLOW_SESSION,
        PERMISSION_DENY,
        PERMISSION_CANCEL,
        PERMISSION_ALLOWED,
        PERMISSION_ALLOWED_SESSION,
        PERMISSION_DENIED,
        PERMISSION_DENIED_STOPPED,
        PERMISSION_WAITING,
        PERMISSION_DIFF_CLAMPED_MARK,
        PERMISSION_NO_COMMAND_NOTE,
        ...Object.values(PERMISSION_DECISION_LABELS),
      ],
      'permission words'
    );
  });
});
