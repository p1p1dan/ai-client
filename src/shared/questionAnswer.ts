/**
 * The question card's multi-select answer as one string, and back.
 *
 * `worker.question.respond` carries an answer per question as a single string
 * (1.0.x's protocol, `QuestionResolvedEvent.answers`): a multi-select joins the
 * picked labels and then the "Other" text with {@link QUESTION_ANSWER_SEPARATOR}.
 * The DSH bridge splits it back into `ask_user_question`'s structured
 * `{selected, custom}` for the model (`dsh-host/bridge/questions.ts`), and the
 * frozen card splits it the same way to list what was picked
 * (dsh-rebase P1-7e problem 8, decision 144). One splitter for both, so the
 * card can never show a different reading than the one the model received.
 *
 * Pure and import-free: the renderer and the host's bridge (loaded by Node
 * type stripping) both read it.
 */

/** What joins a multi-select answer's parts on the wire. */
export const QUESTION_ANSWER_SEPARATOR = ', ';

/** A multi-select answer from its parts: the picked labels, then the Other text. */
export function joinQuestionAnswer(parts: readonly string[]): string {
  return parts.join(QUESTION_ANSWER_SEPARATOR);
}

export interface SplitQuestionAnswer {
  /** The option labels the value starts with, in the order they appear. */
  selected: string[];
  /** Whatever follows the last label: the Other text, or `''`. */
  rest: string;
}

/**
 * Split a joined multi-select value against the question's option labels.
 *
 * A label may itself hold the separator (`smoke, then record`), so at each
 * position the LONGEST label that matches and ends at the value's end or at a
 * separator wins. Whatever follows the last matched label is the Other text,
 * verbatim — it may hold the separator too.
 */
export function splitQuestionAnswer(labels: readonly string[], value: string): SplitQuestionAnswer {
  const byLength = [...new Set(labels)].filter(Boolean).sort((a, b) => b.length - a.length);
  const selected: string[] = [];
  let at = 0;
  while (at < value.length) {
    const label = byLength.find(
      (candidate) =>
        value.startsWith(candidate, at) &&
        (at + candidate.length === value.length ||
          value.startsWith(QUESTION_ANSWER_SEPARATOR, at + candidate.length))
    );
    if (label === undefined) break;
    selected.push(label);
    at += label.length;
    if (at < value.length) at += QUESTION_ANSWER_SEPARATOR.length;
  }
  return { selected, rest: value.slice(at) };
}
