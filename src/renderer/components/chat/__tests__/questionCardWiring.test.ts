import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * S3 slice 4 wiring smoke for `QuestionCard.tsx`'s permission rows — BRITTLE BY
 * DESIGN, same charter and the same stated limits as
 * `messageTimelineWiring.test.ts` (see its header for the full argument):
 * vitest runs in a node environment here, so nothing in this repo can render
 * the component. This asserts PRESENCE of wiring tokens in call position or in
 * executable syntax, parsed through the TypeScript AST so that a comment can
 * never satisfy an assertion. It is not a reachability proof, and it says
 * nothing about whether the value passed is correct.
 *
 * ## Charter: the FIRST hop of the decision wire
 *
 * The chain a permission button travels is
 *
 *   QaOptionRow onSelect  ->  onRespond(decision)          <- THIS FILE
 *   MessageTimeline lambda (permissionDecisionAllows + 3rd argument)
 *                                                          <- messageTimelineWiring.test.ts
 *   store respondPermission -> IPC payload                  <- chatSessionsRespond.test.ts
 *
 * The other two hops are pinned in the files named above; this one was the
 * remaining gap. Everything downstream of it can be correct while this row
 * still sends the wrong thing, because the pure model
 * (`buildPermissionOptionRows` puts a `decision` on every row) and the
 * component that reads it are checked by different tests and nothing joined
 * them.
 *
 * ## The specific regression this exists to catch
 *
 * Spec §3.3's trap. The pre-slice-4 code recovered the answer from the row's
 * LABEL — `option.label === PERMISSION_ALLOW` — which answers false for every
 * row it does not recognise, so an unrecognised row went out as a DENY.
 * Fail-closed in direction, wrong in meaning: the moment a third row exists,
 * pressing "Allow for session" is sent as a refusal and the card comes back
 * Denied. Restoring that comparison passes every other test in the suite.
 *
 * ## Why the negative assertion is not satisfied by prose
 *
 * `QuestionCard.tsx`'s own comment explains the removed code and therefore
 * names it. Two independent reasons that cannot make the negative pass
 * falsely: comments are blanked out of `syntax` below (proved by the control in
 * the first test), and the comment in question wraps the token across two
 * lines, so the forbidden string is not even contiguous in the raw source. Both
 * failure directions are safe — a broken blanker fails this file loudly rather
 * than quietly.
 */

function load(relative: string, kind: ts.ScriptKind) {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);

  // Call expressions and JSX attributes, whitespace-collapsed so that a
  // formatter line break inside a call cannot fail an assertion on its own.
  const callSites: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isJsxAttribute(node)) {
      callSites.push(node.getText(sourceFile).replace(/\s+/g, ' '));
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      callSites.push(node.tagName.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Whole file with comments blanked, strings kept (structural tokens).
  let syntax = source;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  const spans: Array<[number, number]> = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      spans.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
    }
    token = scanner.scan();
  }
  for (const [start, end] of spans.reverse()) {
    syntax = syntax.slice(0, start) + ' '.repeat(end - start) + syntax.slice(end);
  }
  return { callSites, syntax: syntax.replace(/\s+/g, ' ') };
}

describe('QuestionCard.tsx — the permission row sends its own decision (S3 slice 4)', () => {
  const { callSites, syntax } = load('../QuestionCard.tsx', ts.ScriptKind.TSX);

  // Guards the two projections themselves. Without this, an AST walk that
  // silently produced nothing would make every positive below a false pass and
  // every negative vacuous — the failure mode this repo removed from the layout
  // suite (F15) and re-added as a control in every wiring file since.
  it('the projections are non-trivial and comment-free', () => {
    expect(callSites.length).toBeGreaterThan(50);
    expect(syntax.length).toBeGreaterThan(1_000);
    // Prose that exists ONLY in a comment in that file. If it survives, comment
    // blanking has stopped working and the negative below means nothing.
    expect(syntax, 'comment prose leaked into the syntax projection').not.toContain(
      'Same await-and-unlock pattern as Continue/Skip above'
    );
    // …and the negative must be about the COMPARISON, not about the field: the
    // question rows are still keyed by label, so `option.label` itself has to
    // survive or the assertion below is forbidding something already absent.
    expect(syntax, 'question rows are still label-keyed').toContain('{option.label}');
  });

  it('the pressed row hands its decision straight to onRespond', () => {
    // Call position, so the token cannot be satisfied by the comment above it.
    expect(
      callSites.some((site) => site.includes('onRespond?.(decision)')),
      'the permission row must forward the row decision to onRespond'
    ).toBe(true);
    // Where that value comes from: the row itself, not a re-reading of its
    // text. Structural, so it is asserted against the blanked source.
    expect(syntax).toContain('const { decision } = option;');
    // A row without one does nothing — the only safe failure, since the two
    // alternatives are inventing an allow or inverting the user's press.
    expect(syntax).toContain('if (!decision) return;');
  });

  it('§3.3: the label comparison it replaced is gone', () => {
    expect(
      syntax,
      'a row answer derived from its LABEL sends every unrecognised row as a deny'
    ).not.toContain('option.label === PERMISSION_ALLOW');
  });
});
