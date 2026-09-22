import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  ANSWERS_TITLE,
  CONTINUE_CHORD,
  CONTINUE_LABEL,
  OTHER_LABEL,
  PERMISSION_ALLOW,
  PERMISSION_ALLOW_SESSION,
  PERMISSION_ALLOWED,
  PERMISSION_ALLOWED_SESSION,
  PERMISSION_AUTO_REASONS,
  PERMISSION_CANCEL,
  PERMISSION_DECISION_LABELS,
  PERMISSION_DENIED,
  PERMISSION_DENIED_STOPPED,
  PERMISSION_DENY,
  PERMISSION_DIFF_CLAMPED_MARK,
  PERMISSION_NO_COMMAND_NOTE,
  PERMISSION_TITLE,
  PERMISSION_WAITING,
  QUESTION_TITLE,
  SKIP_LABEL,
  SKIPPED_MARK,
  SKIPPED_TITLE,
} from '../questionCardModel';
import { TOOL_VERBS, UNKNOWN_TOOL_VERB } from '../toolCard';
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
    expectTranslated(words, 'tool verbs');
  });

  // T108 retires the action suffix; counts and step words remain translatable.
  it('the aggregate row’s words all have catalog entries', () => {
    expectTranslated(
      [
        '{{count}} tool call',
        '{{count}} tool calls',
        // The process head's own line (decision 033 D1/D4). T112 dropped the
        // singular with the key itself — a head is only rendered for a group
        // that folds (two steps or more), so `{{count}} step processed` could
        // not reach the screen, and a catalog entry nothing looks up is one
        // more word to keep translated for nobody. The bare `{{count}} steps`
        // went the same way on 2026-09-22: the head names the verb now, and
        // nothing else printed the count without it.
        '{{count}} steps processed',
      ],
      'aggregate row words'
    );
  });

  /**
   * T101 — "has an entry" was never enough, and this is the case that proved
   * it.
   *
   * The catalog is keyed by English string with no context dimension, and the
   * editor settings page had claimed `Editing` for its section heading. So the
   * assertion above passed — `Editing` WAS in the catalog — while a running
   * Write row in a Chinese window read “编辑 x.html”, the heading's translation,
   * instead of “编辑中”. A present-but-wrong translation is invisible to a
   * presence check by construction, so the words whose English form is also a
   * plausible UI label elsewhere are spot-checked by value.
   */
  it('the running verbs really mean "in progress", not something else with the same spelling', () => {
    expect(zhTranslations.Editing).toBe('编辑中');
    expect(zhTranslations.Reading).toBe('读取中');
    expect(zhTranslations.Running).toBe('运行中');
    // Both halves of the pair, so a swap between them would fail too.
    expect(zhTranslations.Edited).toBe('已编辑');
    expect(zhTranslations.Read).toBe('读取');
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

  /**
   * chat-tool-04 — a permission card's body label is chosen by the RUNTIME
   * (`preview.label`), which has no locale, and the card renders it with
   * `t(view.content.label)`. That is a dynamic key, so neither the literal
   * `t('…')` scan nor the verb table above can see it: `Skill` had no entry and
   * a Chinese card read one English word under an otherwise Chinese card.
   *
   * The set is closed and small, so it is written out — when a new tool starts
   * sending a preview, this list is the place its label has to be added.
   */
  it('every label a permission body can carry has a catalog entry', () => {
    expectTranslated(
      [
        // Producers: `plugins/tools/index.ts` (write), `plugins/skills/index.ts`,
        // `plugins/mcp/index.ts`.
        'Content',
        'Skill',
        'Arguments',
        // The renderer's own fallbacks, for a gate that carries no preview.
        'Command',
        'Path',
      ],
      'permission body labels'
    );
  });

  /**
   * chat-event-07 — `permissionAutoReason` is a worker enum shown inside our
   * own sentence, so it needs words in both languages like any other copy.
   */
  it('every reason the Host can answer on the user’s behalf has a catalog entry', () => {
    expectTranslated(Object.values(PERMISSION_AUTO_REASONS), 'permission auto reasons');
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

  /**
   * T067 (D20) — the question card's half of the same vocabulary.
   *
   * These constants sat one screen away from the permission words above and
   * were never listed here, which is half the reason they reached a Chinese
   * user in English. The catalog check and the DOM check
   * (`chineseChatSurface.test.ts`) fail in different ways on purpose: a word
   * missing from the table fails here, a render path that never asks fails
   * there, and neither one catches the other's case.
   */
  it('question card words have catalog entries', () => {
    expectTranslated(
      [
        QUESTION_TITLE,
        ANSWERS_TITLE,
        SKIPPED_TITLE,
        OTHER_LABEL,
        SKIP_LABEL,
        CONTINUE_LABEL,
        SKIPPED_MARK,
        CONTINUE_CHORD,
      ],
      'question card words'
    );
  });
});
