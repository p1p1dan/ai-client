import { englishTranslate, type Translate } from '@shared/i18n';
import type {
  PermissionAutoReason,
  PermissionDecisionId,
  PermissionFileChange,
  PermissionRequestAction,
  QuestionItem,
} from '@shared/types/runtimeEvents';
import type { ChatBlock } from '@/stores/chatSessions';
import type { ToolRowView } from './toolCard';

/**
 * T-05 question/permission pure view model. `QuestionCard.tsx` (batch 3)
 * renders three variants off this module: interactive (pending, answerable),
 * frozen (answered/skipped, read-only), and permission (thin adapter over
 * the same card shape). No React, no store writes — freezing logic only
 * reads the store's already-resolved fields (`resolved` / `questionOutcome` /
 * `questionAnswers` / `questionResponse`), never re-implements them.
 */

// ---- State ----

export type QuestionCardState = 'pending' | 'answered' | 'skipped';

/** `resolved !== true` -> 'pending'; outcome 'answered' -> 'answered'; 'cancelled' | 'rejected' -> 'skipped'. */
export function deriveQuestionCardState(block: ChatBlock): QuestionCardState {
  if (block.resolved !== true) return 'pending';
  return block.questionOutcome === 'answered' ? 'answered' : 'skipped';
}

/**
 * T067 (D9/D20 family): the card's fixed copy is CATALOG KEYS, not finished
 * text. `PERMISSION_WAITING` next door already worked this way, which is how
 * the permission variant came out fully Chinese while the question variant —
 * same card, same screen — stayed English through the 2026-09-17 field pass.
 *
 * The constants keep their English wording because the key IS the English
 * string (see `englishTranslate`): every existing assertion on these values
 * stays true, and the render sites add the `t()` the card was missing.
 */
export const QUESTION_TITLE = 'Questions';
export const ANSWERS_TITLE = 'Answers';
export const SKIPPED_TITLE = 'Questions skipped';

/** Header copy KEY: Questions / Answers / Questions skipped (A07 :2654/:2679). */
export function deriveCardTitle(state: QuestionCardState): string {
  if (state === 'answered') return ANSWERS_TITLE;
  if (state === 'skipped') return SKIPPED_TITLE;
  return QUESTION_TITLE;
}

// ---- Selection state (controlled, pure) ----

export interface QuestionSelection {
  /** Question index -> selected labels (single-select is always <= 1 entry). */
  byQuestion: Record<number, string[]>;
  /** Question index -> the Other free-text input. */
  otherText: Record<number, string>;
  /** Question index -> whether the Other row is selected. */
  otherSelected: Record<number, boolean>;
}

export const emptySelection: QuestionSelection = {
  byQuestion: {},
  otherText: {},
  otherSelected: {},
};

/** Single-select: replace (re-clicking the same label keeps it selected, never toggles to empty). Multi-select: toggle. */
export function toggleOption(
  sel: QuestionSelection,
  qIndex: number,
  label: string,
  multiSelect: boolean
): QuestionSelection {
  const current = sel.byQuestion[qIndex] ?? [];
  const nextLabels = multiSelect
    ? current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]
    : [label];

  return {
    ...sel,
    byQuestion: { ...sel.byQuestion, [qIndex]: nextLabels },
    // Picking a structured option in single-select mode is exclusive with Other.
    otherSelected: multiSelect ? sel.otherSelected : { ...sel.otherSelected, [qIndex]: false },
  };
}

/** Selecting Other: single-select clears structured options; multi-select coexists. */
export function toggleOther(
  sel: QuestionSelection,
  qIndex: number,
  multiSelect: boolean
): QuestionSelection {
  if (multiSelect) {
    const isSelected = sel.otherSelected[qIndex] ?? false;
    return { ...sel, otherSelected: { ...sel.otherSelected, [qIndex]: !isSelected } };
  }
  return {
    ...sel,
    byQuestion: { ...sel.byQuestion, [qIndex]: [] },
    otherSelected: { ...sel.otherSelected, [qIndex]: true },
  };
}

export function setOtherText(
  sel: QuestionSelection,
  qIndex: number,
  text: string
): QuestionSelection {
  return { ...sel, otherText: { ...sel.otherText, [qIndex]: text } };
}

// ---- Option rows ----

export interface OptionRow {
  /** 'A'…'Z'; beyond 26 falls back to a plain number string. */
  letter: string;
  label: string;
  isOther: boolean;
  description?: string;
  /**
   * Permission rows only: the decision this row sends. Question rows leave it
   * undefined and are unaffected.
   *
   * It exists because the card used to recover the answer from the LABEL
   * (`option.label === PERMISSION_ALLOW`), which silently turns every row it
   * does not recognise — "Allow for session" first among them — into a deny.
   * A row now carries what it means instead of being re-read as text.
   */
  decision?: PermissionDecisionId;
}

/** Catalog key for the trailing free-text row (T067). */
export const OTHER_LABEL = 'Other…';

export function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Options in order, plus a trailing Other… row (always present, always
 * lettered — A07 :2609).
 *
 * Only the Other… row is translated: the agent's own option labels are its
 * words, not ours, and a catalog lookup on them would either miss (harmless)
 * or collide with an unrelated entry (not harmless).
 */
export function buildOptionRows(item: QuestionItem, t: Translate = englishTranslate): OptionRow[] {
  const rows: OptionRow[] = item.options.map((option, index) => ({
    letter: optionLetter(index),
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    isOther: false,
  }));
  rows.push({ letter: optionLetter(item.options.length), label: t(OTHER_LABEL), isOther: true });
  return rows;
}

// ---- Submission ----

/** Every question needs a selection (or Other with non-empty text) before Continue is enabled. */
export function canContinue(sel: QuestionSelection, items: readonly QuestionItem[]): boolean {
  return items.every((_, index) => {
    const structured = sel.byQuestion[index] ?? [];
    if (structured.length > 0) return true;
    if (!sel.otherSelected[index]) return false;
    return (sel.otherText[index] ?? '').trim().length > 0;
  });
}

/**
 * The answers-map key for one item (S2 C8): the agent's own `id` when it sent
 * one (Codex always does, Claude never does), the question text otherwise.
 *
 * This is the PROTOCOL key. It is deliberately not reused as a React key: two
 * questions in one turn may repeat verbatim (`runtimeEvents.ts` says so in the
 * `QuestionItem.id` comment, which is the whole reason `id` exists), so an
 * id-less pair would collide. `questionReactKey` handles that separately.
 */
export function answerKeyFor(item: QuestionItem): string {
  return item.id ?? item.question;
}

/** Render identity: unique even for two id-less questions with identical text. */
export function questionReactKey(item: QuestionItem, index: number): string {
  return item.id ?? String(index);
}

/**
 * Continue payload, aligned with `respondQuestion` (`chatSessions.ts:125-129`/`:781-798`):
 *  - key is `answerKeyFor(item)` — the agent's id when present, else the text.
 *  - multi-select joins with ', '.
 *  - a selected Other contributes its trimmed text, joined alongside any
 *    structured picks.
 *  - `answers` and `response` are mutually exclusive (:227-230) — this
 *    function only ever produces `answers`.
 */
export function buildRespondPayload(
  sel: QuestionSelection,
  items: readonly QuestionItem[]
): { answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  items.forEach((item, index) => {
    const parts = [...(sel.byQuestion[index] ?? [])];
    if (sel.otherSelected[index]) {
      const text = (sel.otherText[index] ?? '').trim();
      if (text.length > 0) parts.push(text);
    }
    if (parts.length > 0) {
      answers[answerKeyFor(item)] = parts.join(', ');
    }
  });
  return { answers };
}

/** Skip = cancel (store side turns this into outcome 'cancelled' -> frozen as skipped). */
export function buildSkipPayload(): { cancel: true } {
  return { cancel: true };
}

/** Footer copy KEYS (T067) — `QuestionCard.tsx` renders them through `t()`. */
export const SKIP_LABEL = 'Skip';
export const CONTINUE_LABEL = 'Continue';
export const CONTINUE_KBD = '⏎';
export const SKIPPED_MARK = 'Skipped';
/**
 * The submit chord, a key rather than a literal so a platform or locale that
 * words it differently has somewhere to say so. The zh entry is the same text
 * on purpose: a chord is not a sentence.
 */
export const CONTINUE_CHORD = 'Ctrl + Enter';

// ---- Pagination ----

export interface PagerView {
  visible: boolean;
  label: string;
  canPrev: boolean;
  canNext: boolean;
}

export function clampPage(count: number, page: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(page, 0), count - 1);
}

/** A single question never shows a pager (A07 :2586); multiple questions show `${i} of ${count}` with edges disabled. */
export function derivePager(count: number, page: number): PagerView {
  if (count <= 1) {
    return { visible: false, label: '', canPrev: false, canNext: false };
  }
  const clamped = clampPage(count, page);
  return {
    visible: true,
    label: `${clamped + 1} of ${count}`,
    canPrev: clamped > 0,
    canNext: clamped < count - 1,
  };
}

// ---- Frozen (read-only) ----

export interface FrozenPair {
  /** Render identity. Never the question text alone — duplicates are legal. */
  key: string;
  question: string;
  answer: string | null;
  skipped: boolean;
}

/**
 * Fixed-width stand-in for a secret answer. Fixed on purpose: a mask that grew
 * with the value would leak its length, and length is information about a key.
 */
export const SECRET_MASK = '••••••••';

/**
 * Should this answer be hidden in the timeline?
 *
 * Only free text is masked. `isSecret` is a QUESTION-level flag, but the answer
 * may well be one of the offered option labels ("Use environment variable"),
 * which is public by construction — masking it would protect nothing while
 * making the user unable to see what they answered. So: mask exactly when the
 * answer did not come from the option list.
 *
 * The repo's position is that a credential must not sit in the timeline
 * permanently (the same reason the Host redacts stderr, T-35); it is not that
 * answers to sensitive-sounding questions should be unreadable.
 */
export function isMaskedAnswer(item: QuestionItem, answer: string | null): boolean {
  if (item.isSecret !== true || answer === null || answer.length === 0) return false;
  return !item.options.some((option) => option.label === answer);
}

/**
 * Frozen render data, entirely from fields the store already froze (no
 * reimplementation of D20 logic):
 *  - answered: `answer = questionAnswers[answerKeyFor(item)] ?? questionResponse ?? null`,
 *    masked when `isMaskedAnswer` says so.
 *  - skipped: every question shows `answer: null, skipped: true`.
 *  - missing `questions` (history/edge case) -> empty array.
 */
export function deriveFrozenPairs(block: ChatBlock): FrozenPair[] {
  const items = block.questions ?? [];
  if (items.length === 0) return [];

  if (deriveQuestionCardState(block) === 'skipped') {
    return items.map((item, index) => ({
      key: questionReactKey(item, index),
      question: item.question,
      answer: null,
      skipped: true,
    }));
  }

  return items.map((item, index) => {
    const answer = block.questionAnswers?.[answerKeyFor(item)] ?? block.questionResponse ?? null;
    return {
      key: questionReactKey(item, index),
      question: item.question,
      answer: isMaskedAnswer(item, answer) ? SECRET_MASK : answer,
      skipped: false,
    };
  });
}

// ---- Permission thin adapter ----

/**
 * The card's fixed vocabulary, as TRANSLATION KEYS.
 *
 * English is the key, not the copy: a Chinese UI showed literal "Allow" /
 * "Deny" buttons because these constants went straight to the DOM. They now go
 * through `t` — at the render site for the ones that reach paint as a bare word
 * (`ToolRows.tsx` translates a row's `verb`), and inside the builders below for
 * the ones that get composed into a longer string first.
 */
export const PERMISSION_TITLE = 'Permission';
export const PERMISSION_ALLOW = 'Allow';
export const PERMISSION_ALLOW_SESSION = 'Allow for session';
/**
 * T002 — decision 003 kept the grant session-scoped rather than narrowing it
 * to the delegate that asked (cross-05): a subagent's "Allow for session"
 * also covers the parent and every other subagent for the same tool and
 * path. The button itself cannot say that in three words, so this is the
 * line under it.
 */
export const PERMISSION_ALLOW_SESSION_NOTE =
  'Applies to every agent in this session, including subagents';
export const PERMISSION_DENY = 'Deny';
/**
 * Deliberately not a synonym for Deny. The contract says this decision also
 * interrupts the turn, so the copy has to make a user who reads only the button
 * expect that.
 */
export const PERMISSION_CANCEL = 'Deny and stop';
export const PERMISSION_ALLOWED = 'Allowed';
export const PERMISSION_ALLOWED_SESSION = 'Allowed for session';
export const PERMISSION_DENIED = 'Denied';
export const PERMISSION_DENIED_STOPPED = 'Denied, turn stopped';
export const PERMISSION_WAITING = 'Waiting';

/**
 * Button copy per decision id — renderer-local on purpose. The module that
 * knows the wire dialects (`src/agent-host/codexDecisions.ts`) belongs to a
 * separate program this bundle cannot import (`tsconfig.web.json` include /
 * aliases), so the wire values live on that side of the boundary and the words
 * a user reads live on this one.
 */
export const PERMISSION_DECISION_LABELS: Readonly<Record<PermissionDecisionId, string>> = {
  allow: PERMISSION_ALLOW,
  allow_session: PERMISSION_ALLOW_SESSION,
  deny: PERMISSION_DENY,
  cancel: PERMISSION_CANCEL,
};

/** Past tense of the same four, for a card that has already been answered. */
const PERMISSION_DECISION_VERBS: Readonly<Record<PermissionDecisionId, string>> = {
  allow: PERMISSION_ALLOWED,
  allow_session: PERMISSION_ALLOWED_SESSION,
  deny: PERMISSION_DENIED,
  cancel: PERMISSION_DENIED_STOPPED,
};

/** What every pre-S2 Host offered, and what a request naming no decisions gets. */
const DEFAULT_PERMISSION_DECISIONS: readonly PermissionDecisionId[] = ['allow', 'deny'];

/**
 * `allow` derived from the decision, in this ONE place.
 *
 * The Host command keeps `allow` required, so something has to compute it; if
 * two call sites did, they would eventually disagree about `allow_session` and
 * produce the exact failure this projection exists to prevent — a card that
 * says Allowed over a wire reply that said decline.
 */
export function permissionDecisionAllows(decision: PermissionDecisionId): boolean {
  return decision === 'allow' || decision === 'allow_session';
}

/**
 * `Object.hasOwn`, not `in`: these values come off the wire, and `in` walks the
 * prototype chain — `'constructor'` would pass and then be "labelled" with
 * `Object.prototype.constructor`.
 */
function isKnownDecision(value: unknown): value is PermissionDecisionId {
  return typeof value === 'string' && Object.hasOwn(PERMISSION_DECISION_LABELS, value);
}

/**
 * The buttons this card offers.
 *  - key absent -> the historical Allow / Deny pair, byte for byte (every
 *    Claude-side card takes this path).
 *  - an offered id this build has no label for is dropped rather than rendered
 *    as a blank row.
 *  - if that leaves nothing, the card falls back to Deny alone: a card with no
 *    buttons cannot be answered at all (the hang this whole path fights), while
 *    synthesising an Allow the Host never offered is the worse of the two
 *    errors. The Host guarantees a deny is always among the decisions, so this
 *    branch only fires for a payload that broke that promise.
 */
function resolvePermissionDecisions(block: ChatBlock): PermissionDecisionId[] {
  const offered = block.permissionDecisions;
  if (offered === undefined) return [...DEFAULT_PERMISSION_DECISIONS];
  const known = offered.filter(isKnownDecision);
  return known.length > 0 ? known : ['deny'];
}

/** One lettered row per decision, each carrying the id it will send. */
export function buildPermissionOptionRows(decisions: readonly PermissionDecisionId[]): OptionRow[] {
  return decisions.map((decision, index) => ({
    letter: optionLetter(index),
    label: PERMISSION_DECISION_LABELS[decision],
    isOther: false,
    decision,
  }));
}

/**
 * Card-bottom line for decisions the Host could not model (C9 pins the
 * position): a narrowed choice must never look like the whole choice.
 */
export function derivePermissionOmittedNote(
  count: number | undefined,
  t: Translate = englishTranslate
): string | null {
  if (count === undefined || count <= 0) return null;
  return t('The runtime offered {{count}} more options this build cannot show', { count });
}

/**
 * T002 — shown only when the card actually offers "Allow for session": a row
 * that never renders the button has nothing to explain the scope of.
 */
export function derivePermissionSessionScopeNote(
  options: readonly OptionRow[],
  t: Translate = englishTranslate
): string | null {
  return options.some((option) => option.decision === 'allow_session')
    ? t(PERMISSION_ALLOW_SESSION_NOTE)
    : null;
}

/**
 * The verb a settled card shows: the decision when we have one, else the
 * boolean. Returned as a KEY — its two render sites (`ToolRows.tsx`'s row tail
 * and the frozen answer below) translate it.
 */
export function derivePermissionVerb(block: ChatBlock): string {
  const decision = block.permissionDecision;
  if (isKnownDecision(decision)) return PERMISSION_DECISION_VERBS[decision];
  return block.allowed ? PERMISSION_ALLOWED : PERMISSION_DENIED;
}

/**
 * chat-event-07 — the worker's `PermissionAutoReason` enum, worded.
 *
 * Same rule as `PERMISSION_ACTION_LABELS` right below: the producer has no
 * locale, so it sends an id and the sentence is chosen here, in English that
 * doubles as the dictionary key. Before this the enum was interpolated raw and
 * a Chinese card read 「自动：timed_out」 — an identifier, underscore included,
 * inside our own sentence.
 *
 * An id this build has never seen falls through to itself rather than to
 * nothing: an unfamiliar word is still better evidence than a blank tail.
 */
export const PERMISSION_AUTO_REASONS: Readonly<Record<PermissionAutoReason, string>> = {
  unsupported: 'unsupported',
  session_closed: 'session closed',
  aborted: 'aborted',
  timed_out: 'timed out',
};

/**
 * `auto: <reason>` when the Host answered on the user's behalf.
 *
 * Absent means a human decided — which is what a resolved card has always
 * implied and, before this field existed, could not prove: a drained approval
 * was drawn as a plain "Denied", indistinguishable from a real refusal.
 */
export function derivePermissionAutoNote(
  block: ChatBlock,
  t: Translate = englishTranslate
): string | null {
  const reason = block.permissionAutoReason;
  if (!reason) return null;
  return t('auto: {{reason}}', { reason: t(PERMISSION_AUTO_REASONS[reason] ?? reason) });
}

/** Provenance always goes at the tail, whichever string carries it. */
function withAutoNote(text: string, block: ChatBlock, t: Translate): string {
  const note = derivePermissionAutoNote(block, t);
  return note ? `${text} · ${note}` : text;
}

// ---- Permission card body ----

/** Key, translated where it renders (`QuestionCard.tsx`'s file row). */
export const PERMISSION_DIFF_CLAMPED_MARK = 'diff clamped';
/**
 * A command approval whose `command` is null is a declared shape, not a broken
 * frame — so the card says what it does not know instead of rendering an empty
 * box (and instead of auto-denying a whole class of approval).
 *
 * A key like the rest, so the `en` locale stops showing a Chinese sentence.
 */
export const PERMISSION_NO_COMMAND_NOTE = 'The runtime reported no command for this request';

const PERMISSION_CHANGE_BADGES: Readonly<Record<PermissionFileChange['change'], string>> = {
  add: 'A',
  update: 'M',
  delete: 'D',
  rename: 'R',
};

export interface PermissionFileRow {
  key: string;
  path: string;
  change: PermissionFileChange['change'];
  /** Single letter: A / M / D / R. */
  badge: string;
  /** `+a/-b` counted from the unified diff; null when no diff reached us. */
  stat: string | null;
  /** The Host clamped this diff, so the counts above are a lower bound. */
  truncated: boolean;
}

/**
 * `+added/-removed` for one unified diff.
 *
 * Hunk-aware, and it has to be. A body line is a `+`/`-` glued to the file's
 * own text, so deleting a line that itself begins with `--` produces `---foo`
 * and adding one that begins with `++` produces `+++x`. Skipping every line
 * with those prefixes — the previous rule — swallowed exactly those changes:
 * the card under-counted the edits that look most like a header.
 *
 * The header skip is therefore scoped to where headers actually live: before
 * the first `@@`, and only for the marker-plus-space spelling (`--- a/x`,
 * `+++ b/x`) that a real file header always has. A multi-file patch restarts
 * that state at its `diff ` separator, so the second file's headers do not
 * become changes.
 *
 * The "\ No newline at end of file" marker starts with a backslash and
 * therefore never counts. Returns null when no diff arrived — which is NOT the
 * same as `+0/-0` and must not be drawn as an empty change.
 *
 * Codex's `add` diffs are bare file CONTENT — no `@@`, no `+`/`-` prefixes
 * [实测 codex-filechange-approval-turn.jsonl:8] — and still count `+0/-0`.
 * Unchanged and deliberate: deriving "+N" from a body nobody told us was a
 * patch would be a number with nothing behind it.
 */
export function countDiffStat(diff: string | undefined): { added: number; removed: number } | null {
  if (diff === undefined) return null;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    // Every well-formed body line starts with ' ', '+', '-' or '\', so a bare
    // `diff ` can only be the separator between two files' patches.
    if (line.startsWith('diff ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * What the card shows under its prompt. Summary only — the diff BODY is not
 * rendered here (the repo's one diff surface is a Monaco `DiffEditor` bound to
 * git paths, not unified-diff strings; a real diff view is its own task).
 */
export interface PermissionDetailView {
  kind: 'exec' | 'file_change';
  /** exec: the command line, rendered mono. null = the request carried none. */
  command: string | null;
  /** Secondary lines: cwd, network target. */
  meta: string[];
  /** file_change: one row per touched file, in Host order. */
  files: PermissionFileRow[];
  /**
   * What pressing Allow grants BEYOND the literal request. Emphasised because
   * a user cannot infer any of it from the command or the patch in front of
   * them — a patch approval carrying `grantRoot` hands out a session-long
   * directory write, and an exec carrying `additionalPermissions` widens the
   * session's posture.
   */
  warnings: string[];
  /** Footnotes: what this card cannot show. */
  notes: string[];
}

/**
 * A body with nothing in it is not a body. The Host sends `{kind:'file_change',
 * changes: []}` whenever the patch had not arrived yet (it never withholds the
 * card waiting for one), and rendering that as a body leaves an empty padded
 * box under the prompt — the class of layout defect that only shows up in a
 * screenshot. The card then draws its prompt and its buttons and nothing else,
 * which is exactly what "detail omitted" is supposed to look like.
 */
function isEmptyDetailView(view: PermissionDetailView): boolean {
  return (
    view.command === null &&
    view.meta.length === 0 &&
    view.files.length === 0 &&
    view.warnings.length === 0 &&
    view.notes.length === 0
  );
}

export function derivePermissionDetailView(
  block: ChatBlock,
  t: Translate = englishTranslate
): PermissionDetailView | null {
  const detail = block.permissionDetail;
  if (!detail) return null;

  if (detail.kind === 'exec') {
    const meta: string[] = [];
    if (detail.cwd) meta.push(t('cwd: {{path}}', { path: detail.cwd }));
    if (detail.network) {
      meta.push(
        t('Network: {{target}}', {
          target: `${detail.network.protocol}://${detail.network.host}`,
        })
      );
    }
    const warnings: string[] = [];
    if (detail.extraPermissions) {
      const { fileSystemEntries, networkRequested } = detail.extraPermissions;
      warnings.push(
        t(
          'This command also asked for extra permissions ({{files}} file entries / network {{network}})',
          {
            files: fileSystemEntries,
            network: networkRequested ? t('yes') : t('no'),
          }
        )
      );
    }
    const command = detail.command ?? null;
    return {
      kind: 'exec',
      command,
      meta,
      files: [],
      warnings,
      notes: command === null ? [t(PERMISSION_NO_COMMAND_NOTE)] : [],
    };
  }

  const files: PermissionFileRow[] = detail.changes.map((change, index) => {
    const stat = countDiffStat(change.diff);
    return {
      // Path alone is not a key: a rename can list the same path twice.
      key: `${index}:${change.path}`,
      path: change.path,
      change: change.change,
      badge: PERMISSION_CHANGE_BADGES[change.change] ?? '?',
      stat: stat ? `+${stat.added}/-${stat.removed}` : null,
      truncated: change.truncated === true,
    };
  });
  const warnings: string[] = [];
  if (detail.grantRoot) {
    warnings.push(
      t('Also grants writes under {{path}} for this session', { path: detail.grantRoot })
    );
  }
  const notes: string[] = [];
  if (detail.omittedFileCount !== undefined && detail.omittedFileCount > 0) {
    notes.push(t('{{count}} more files are not shown', { count: detail.omittedFileCount }));
  }
  const view: PermissionDetailView = {
    kind: 'file_change',
    command: null,
    meta: [],
    files,
    warnings,
    notes,
  };
  // Only reachable on this arm: an exec always has either a command or the
  // "no command reported" note, so its body is never empty.
  return isEmptyDetailView(view) ? null : view;
}

/** How loud the card reads. Derived here, not sent: it is a presentation call. */
export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionCardView {
  title: string;
  prompt: string;
  risk: PermissionRisk;
  /**
   * The thing being approved, shown verbatim: the content about to be written,
   * or the command about to run. This is what the decision is ABOUT, and the
   * card that printed `tool`, `rule` and a serialized argument object instead
   * is the one the 2026-09-10 screenshots caught.
   */
  content: { label: string; text: string } | null;
  /** Project the request belongs to, for the card's context line. */
  workspace: string | null;
  state: 'pending' | 'resolved';
  /** One row per offered decision when pending and answerable, otherwise empty. */
  options: OptionRow[];
  /** Read-only row (Allowed/Denied…) once resolved. */
  frozen: FrozenPair[];
  waiting: boolean;
  /** Card body; null for a plain tool request, which has no detail. */
  detail: PermissionDetailView | null;
  /** Card-bottom line when the Host dropped decisions it could not model. */
  omittedNote: string | null;
  /** T002 — scope reminder, present only when `options` offers `allow_session`. */
  sessionScopeNote: string | null;
}

/**
 * T023 — the wording for each `PermissionRequestAction`, English-as-key.
 *
 * The producer is the worker (`src/runtime/worker/permissionPrompt.ts`), which
 * has no locale, so it sends an id and this table is where the sentence is
 * chosen. Same treatment `contentLabel` gets a few functions down: English in
 * the code IS the dictionary key, `zhTranslations` carries the Chinese, and
 * "is this translated" stays a question about where the Chinese lives.
 */
export const PERMISSION_ACTION_LABELS: Readonly<Record<PermissionRequestAction, string>> = {
  run_command: 'Run a command in the workspace',
  write_file: 'Write a file in the workspace',
  edit_file: 'Modify a file in the workspace',
  read_file: 'Read file contents',
};

/**
 * The line under the title: what is being asked, in one sentence.
 *
 * Two sources, and the order matters. `permissionAction` is OUR copy and is
 * translated; `toolDescription` is prose the agent wrote (Codex's `reason`,
 * Claude's `description`) and is shown verbatim, because translating an
 * agent's own justification would be inventing words it did not say. An
 * unknown action id falls through to the agent's prose and then to the bare
 * tool name — a card that says less, never one that says something wrong.
 */
function derivePermissionPrompt(block: ChatBlock, t: Translate = englishTranslate): string {
  const toolName = block.toolName ?? '';
  const label = block.permissionAction
    ? PERMISSION_ACTION_LABELS[block.permissionAction]
    : undefined;
  const description = label ? t(label) : block.toolDescription;
  return description ? `${toolName} — ${description}` : toolName;
}

/**
 * Writing files and running commands are the two the app cannot take back, so
 * they read loud; anything else that reached a gate at all is worth showing
 * without shouting.
 */
export function derivePermissionRisk(block: ChatBlock): PermissionRisk {
  if (block.permissionKind === 'exec' || block.permissionKind === 'file_change') return 'high';
  const tool = (block.toolName ?? '').toLowerCase();
  if (tool === 'bash' || tool === 'write' || tool === 'edit') return 'high';
  return 'medium';
}

function readInputField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Seconds left before the asker stops waiting, or null when it stated no
 * deadline. Never negative: a card that outlived its gate says zero and the
 * component answers `deny` once, which is the same answer the engine's own
 * abort produces — the two agree rather than race.
 */
export function permissionSecondsLeft(expiresAt: number | undefined, now: number): number | null {
  if (expiresAt === undefined) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * The verbatim body, preferring what the tool is about to WRITE over what it
 * was called with. A command already appears in the exec detail, so it is only
 * used here when there is no content — never both, which would print the same
 * string twice under two labels.
 */
export function derivePermissionContent(block: ChatBlock): { label: string; text: string } | null {
  const content = readInputField(block.toolInput, 'content');
  if (content) {
    // `contentLabel` is the runtime's own word for this body (`Content` for a
    // write, `Skill` for a skill, `Arguments` for an MCP call). It is English
    // there because the worker has no locale, so it is treated as a catalog KEY
    // here and translated where the card paints it — the same treatment the
    // fallback gets, so the two cannot drift into different languages on one
    // card.
    return { label: readInputField(block.toolInput, 'contentLabel') ?? 'Content', text: content };
  }
  if (block.permissionDetail?.kind === 'exec') return null;
  const command = readInputField(block.toolInput, 'command');
  if (command) return { label: 'Command', text: command };
  // chat-tool-02 — nothing to write and nothing to run leaves the PATH as the
  // whole request, which is what the producer says too ("a read or a glob is
  // fully described by its path", `ToolPermissionRequest.preview`). Without
  // this the card asked for a decision about a file it never named, and
  // `browser_preview` got a body consisting of the word `browser_preview`.
  //
  // A `file_change` detail already draws its paths as file rows, so it is not
  // repeated here — that would print the same path twice on one card.
  if (block.permissionDetail?.kind === 'file_change') return null;
  const path = readInputField(block.toolInput, 'path');
  return path ? { label: 'Path', text: path } : null;
}

/**
 * Block-level gate for the permission card's Allow/Deny rows. True only when
 * the Host still has *this* permissionId parked for the active session — so a
 * sibling card being answered, a replayed block, or another session's prompt
 * can never make it answerable.
 */
export function canRespondToPermission(
  pending: readonly { sessionId: string; permissionId: string }[],
  activeSessionId: string | null,
  permissionId: string | undefined
): boolean {
  if (!activeSessionId || !permissionId) return false;
  // Serialized presentation (user ruling 2026-07-30): concurrent permission
  // requests queue up, but only the HEAD of this session's queue is answerable
  // — the rest render as waiting until the one before them is resolved. This
  // also structurally removes the misattribution hazard (answering a card
  // other than the one the reply is wired to).
  const head = pending.find((item) => item.sessionId === activeSessionId);
  return head !== undefined && head.permissionId === permissionId;
}

/**
 * The `2/5` in the dock card's top-left corner, or `null` for "say nothing".
 *
 * Pure and here rather than inside the card, because the two suppression rules
 * are the whole feature and neither can be asserted from a `.tsx` in this
 * node-only suite:
 *
 *  1. **A lone request says nothing.** `1/1` is a progress indicator for a queue
 *     of one — noise on the card it sits on, and worse than noise on the card
 *     the user sees most often.
 *  2. **A missing field says nothing.** The legacy backend and any older worker
 *     send neither number, so both are optional all the way from the wire
 *     (`PermissionRequestedEvent`) to here. Rendering them unchecked is how a
 *     card ends up wearing `undefined/undefined`.
 *
 * The denominator is DEPTH-AS-OF-NOW, not a total: the gate keeps taking
 * requests while the user reads, so `2/5` legitimately follows `1/3`. That is
 * why this returns text and not a fraction — a progress BAR built on it would
 * jump backwards. See `PermissionRequestedEvent.payload.queueDepth`.
 */
export function derivePermissionQueueProgress(entry: {
  queuePosition?: number;
  queueDepth?: number;
}): string | null {
  const { queuePosition, queueDepth } = entry;
  if (queuePosition === undefined || queueDepth === undefined) return null;
  // Integers only, and never a position past the depth: a malformed pair is a
  // producer bug, and drawing `3/2` would make the card argue with itself.
  if (!Number.isInteger(queuePosition) || !Number.isInteger(queueDepth)) return null;
  if (queueDepth <= 1 || queuePosition < 1 || queuePosition > queueDepth) return null;
  return `${queuePosition}/${queueDepth}`;
}

export function derivePermissionCardView(
  block: ChatBlock,
  canRespond: boolean,
  t: Translate = englishTranslate
): PermissionCardView {
  const prompt = derivePermissionPrompt(block, t);
  const detail = derivePermissionDetailView(block, t);
  const omittedNote = derivePermissionOmittedNote(block.omittedDecisionCount, t);
  const risk = derivePermissionRisk(block);
  const content = derivePermissionContent(block);
  const workspace = readInputField(block.toolInput, 'workspace');

  if (block.resolved === true) {
    return {
      title: PERMISSION_TITLE,
      prompt,
      risk,
      content,
      workspace,
      state: 'resolved',
      options: [],
      frozen: [
        {
          key: 'permission',
          question: prompt,
          answer: withAutoNote(t(derivePermissionVerb(block)), block, t),
          skipped: false,
        },
      ],
      waiting: false,
      detail,
      omittedNote,
      sessionScopeNote: null,
    };
  }

  if (canRespond) {
    const options = buildPermissionOptionRows(resolvePermissionDecisions(block));
    return {
      title: PERMISSION_TITLE,
      prompt,
      risk,
      content,
      workspace,
      state: 'pending',
      options,
      frozen: [],
      waiting: false,
      detail,
      omittedNote,
      sessionScopeNote: derivePermissionSessionScopeNote(options, t),
    };
  }

  return {
    title: PERMISSION_TITLE,
    prompt,
    risk,
    content,
    workspace,
    state: 'pending',
    options: [],
    frozen: [],
    waiting: true,
    detail,
    omittedNote,
    sessionScopeNote: null,
  };
}

/**
 * Resolved-permission row view — same source data as `derivePermissionCardView`'s
 * `resolved` branch, reshaped into a `ToolRowView` so `PermissionQaCard` can
 * render one compact tool-row instead of the full QA shell once the decision
 * is made (2026-08-10 ruling: only the decided state collapses; pending/
 * waiting still renders the interactive QA card). Returns `null` while the
 * permission is not yet resolved — callers keep using
 * `derivePermissionCardView` for that state.
 */
export function derivePermissionRowView(
  block: ChatBlock,
  originLabel?: string | null,
  t: Translate = englishTranslate
): ToolRowView | null {
  if (block.resolved !== true) return null;
  const prompt = derivePermissionPrompt(block, t);
  return {
    key: block.id,
    // A key, per `ToolRowView.verb` — `ToolRows.tsx` translates it.
    verb: derivePermissionVerb(block),
    // `auto:` sits after the origin chip because both are provenance and the
    // tail is where this row puts it; the verb stays the decision alone.
    arg: withAutoNote(originLabel ? `${prompt} · ${originLabel}` : prompt, block, t),
    argKind: 'prose',
    running: false,
    // Still the boolean: `allow_session` is an allow and `cancel` is a deny,
    // and the Host derives this same boolean from the same decision.
    failed: block.allowed === false,
    expandable: false,
  };
}

// ---- Dock layout (A07 :2709 — 8px gap above the Composer) ----

export const QUESTION_DOCK_WRAPPER_CLASS = 'shrink-0 px-6 pb-2';
/** Expanded card's own scroll window (sign-off ② generic 60vh; A07 gives no number). */
export const QUESTION_CARD_BODY_MAX_CLASS = 'max-h-[60vh] overflow-auto';

// ---- Pending selector ----

/**
 * Pull the pending question block from `messages`; returns the block
 * reference itself (stable under streaming append, so it can back a zustand
 * selector directly).
 */
export function selectPendingQuestionBlock(
  messages: Record<string, { id: string; blocks: ChatBlock[] }[]>,
  pending: { sessionId: string; questionId: string; messageId: string } | null,
  activeSessionId: string | null
): ChatBlock | undefined {
  if (!pending || !activeSessionId || pending.sessionId !== activeSessionId) return undefined;
  const bucket = messages[pending.sessionId];
  if (!bucket) return undefined;
  const message = bucket.find((item) => item.id === pending.messageId);
  if (!message) return undefined;
  return message.blocks.find(
    (block) => block.type === 'question' && block.questionId === pending.questionId
  );
}
