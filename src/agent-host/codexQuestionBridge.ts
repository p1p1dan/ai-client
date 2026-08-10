import type { QuestionItem, QuestionOption } from '../shared/types/runtimeEvents.ts';

/**
 * Codex question bridge (S3 slice 3) — the two translations between
 * `item/tool/requestUserInput` and our `question.requested` /
 * `question.respond` pair.
 *
 * PURE. No state, no emit, no wire writes: the state lives in
 * `PendingServerRequestTable`, the emits live in `codexRuntime`. That split is
 * what lets the acceptance tests drive real captured frames through this file
 * without a process, and it is why "the bridge never emits session.status"
 * (C10 rule 3) is enforced at the runtime's emit array rather than here — a
 * module with no emit channel satisfies that assertion vacuously.
 *
 * Deliberately shares NOTHING with `questionBridge.ts` (Claude). C15 ruled the
 * common settler base class out, and the reason is visible in one line: on this
 * wire an empty answers map IS a clean cancel [实测 S2-a], while the Claude CLI
 * silently re-asks when answers are missing, so its bridge refuses empty
 * payloads. A shared parent would have to weld those two opposite meanings
 * together.
 *
 * Shapes are pinned by `__tests__/fixtures/codex/codex-question-schema.json`,
 * lifted verbatim from the binary's own generated JSON Schema.
 */

/** One answer in `ToolRequestUserInputResponse` [实测 schema: `{answers: string[]}`]. */
interface CodexAnswer {
  answers: string[];
}

export interface CodexAnswerBody {
  answers: Record<string, CodexAnswer>;
}

/** What `question.respond` carries by the time `index.ts` has validated it. */
export interface CodexQuestionRespondInput {
  answers?: Record<string, string>;
  response?: string;
  cancel?: boolean;
}

export interface QuestionItemsReading {
  items: QuestionItem[];
  /**
   * Questions dropped for having no usable text. Surfaced so the caller can
   * tell "codex asked nothing" from "codex asked and we understood none of it"
   * — both end in the same fail-safe reply, but only one of them is a bug on
   * our side.
   */
  dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `options` is `["array","null"]` in the generated contract
 * [契约 codex-question-schema.json: ToolRequestUserInputQuestionOptionsType],
 * even though all five retained sample questions carry a populated array
 * [实测]. The fixture README used to record the contract as "fake"; it is not,
 * and the cost of being wrong in that direction is a TypeError on a question we
 * could have rendered. Anything that is not an array reads as "no options",
 * which the card handles: it appends an "Other…" row unconditionally, so a
 * question with zero options is still answerable.
 */
function toOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const label = nonEmptyString(entry.label);
    if (!label) continue;
    const description = nonEmptyString(entry.description);
    options.push({ label, ...(description ? { description } : {}) });
  }
  return options;
}

/**
 * `ToolRequestUserInputParams.questions` -> our `QuestionItem[]`.
 *
 * Two fields are read by NOBODY here, on purpose, and both have an explicit
 * acceptance test so "decided not to" stays distinguishable from "forgot to":
 *
 *  - `isOther` — our card always offers a free-text "Other…" row, so honouring
 *    the flag could only ever take an answer away (S2 §5-6).
 *  - `multiSelect` — codex has no such field at all [实测 schema], so writing
 *    one would be inventing a capability. Its absence is what makes the answer
 *    for a codex question always a single string; see `toCodexAnswerBody`.
 */
export function toQuestionItems(params: unknown): QuestionItemsReading {
  const raw = isRecord(params) ? params.questions : undefined;
  if (!Array.isArray(raw)) return { items: [], dropped: 0 };

  const items: QuestionItem[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const question = nonEmptyString(entry.question);
    if (!question) {
      // A question with no text cannot be rendered and cannot be answered
      // meaningfully. Dropped rather than shown blank.
      dropped += 1;
      continue;
    }
    const header = nonEmptyString(entry.header);
    // `id` is required by the contract, so a missing one means a codex we do
    // not know. We do NOT mint a substitute: a synthesized id would key the
    // answers map with something the server never sent, and the answer would be
    // dropped server-side with no error. Falling back to the question text is
    // the documented C8 behaviour and at least has a chance of matching.
    const id = nonEmptyString(entry.id);
    items.push({
      question,
      ...(header ? { header } : {}),
      options: toOptions(entry.options),
      ...(id ? { id } : {}),
      // Absent means false in the protocol; writing `false` explicitly would
      // make every Claude question differ from every codex question in the
      // event payload for no reason.
      ...(entry.isSecret === true ? { isSecret: true } : {}),
    });
  }
  return { items, dropped };
}

/**
 * `autoResolutionMs` passthrough. `undefined` = the key was absent or held
 * something we do not understand, in which case we omit it rather than assert
 * `null` (which means "never auto-resolves" and would be a claim we cannot
 * back). NOT implemented client-side this round — see the acceptance test that
 * pins the non-behaviour.
 */
export function readAutoResolutionMs(params: unknown): number | null | undefined {
  const raw = isRecord(params) ? params.autoResolutionMs : undefined;
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** The answers-map key for one item: `id` when the agent sent one, else the text (C8). */
export function answerKeyFor(item: QuestionItem): string {
  return item.id ?? item.question;
}

/**
 * `question.respond` -> `ToolRequestUserInputResponse`.
 *
 * ## Why the value is never split on ", "
 *
 * The S2 design said to split it back into an array. That was written before we
 * had the generated contract, which shows `ToolRequestUserInputQuestion` has no
 * multi-select field at all [实测]. Our renderer only joins parts with ", " when
 * `multiSelect === true` (`questionCardModel.ts` `toggleOption` / `toggleOther`
 * keep a single-select question's selection at exactly one entry), and this
 * bridge never sets that flag — so for a codex question the value is always ONE
 * part and there is nothing a split could correctly recover.
 *
 * What a split CAN do is damage: the one input that contains ", " in practice
 * is free text the user typed into the Other row (a host and a port, a path
 * list, a sentence), and splitting it hands the model several truncated answers
 * with no way to notice. A rule that can only ever misfire is not a rule worth
 * having; when codex grows multi-select, the split arrives together with the
 * `multiSelect` mapping that makes it meaningful.
 *
 * ## Why `response` is not broadcast
 *
 * `question.respond` may carry a free-text `response` instead of `answers`
 * (the Claude shape; `index.ts` forwards it verbatim for every agent). Folding
 * it into every unmatched item would tell the model it answered questions it
 * was never asked, so it is only used when the card had exactly one question.
 */
export function toCodexAnswerBody(
  items: readonly QuestionItem[],
  input: CodexQuestionRespondInput
): { body: CodexAnswerBody; unmatched: number; responseIgnored: boolean } {
  // A clean cancel on this wire [实测 S2-a]: the model does not re-ask and the
  // turn finishes normally. The exact opposite of the Claude CLI, which is why
  // C15 forbade a shared base class.
  if (input.cancel === true) {
    return { body: { answers: {} }, unmatched: 0, responseIgnored: false };
  }

  const response = nonEmptyString(input.response);
  const soleItem = items.length === 1;
  const answers: Record<string, CodexAnswer> = {};
  let unmatched = 0;
  let responseUsed = false;

  for (const item of items) {
    const key = answerKeyFor(item);
    const value = input.answers?.[key];
    const usable = nonEmptyString(value);
    if (usable !== undefined) {
      answers[key] = { answers: [usable] };
      continue;
    }
    if (response !== undefined && soleItem) {
      answers[key] = { answers: [response] };
      responseUsed = true;
      continue;
    }
    // Key omitted rather than sent as an empty array. Both are [推测]: every
    // retained reply wrote a key for every question asked, so we have no sample
    // of either. Omission was chosen because an empty array's meaning is
    // unknown and could plausibly read as "answered with nothing", while a
    // missing key can only read as "not answered". If the server ever rejects
    // this with -32602, the fix is to write `{answers: []}` here.
    unmatched += 1;
  }

  return {
    body: { answers },
    unmatched,
    responseIgnored: response !== undefined && !responseUsed,
  };
}
