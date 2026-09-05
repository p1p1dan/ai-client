import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * T-31 review batch, F8: wiring smoke. BRITTLE BY DESIGN.
 *
 * ## Why a source-level test exists at all
 *
 * `vitest` runs in a node environment here (spec §6.2), so nothing in this repo
 * can render `MessageTimeline` and assert on the result. Every defect this
 * review batch fixed lived in exactly that blind spot: the pure functions were
 * correct and tested, and the `.tsx` either called them with the wrong argument
 * (F2/F4), dropped a required prop (F5), or never called them at all. The
 * decision logic is now extracted and truth-tabled in `turnHead.test.ts`; this
 * file covers the one remaining layer — that the component actually reaches for
 * it.
 *
 * ## WHAT THIS TEST CLAIMS, AND WHAT IT DOES NOT
 *
 * The claim is **presence in call / JSX-attribute position** — that the source
 * of `MessageTimeline.tsx` contains a real call expression or a real JSX
 * attribute naming the wiring under assertion.
 *
 * It is **not a reachability proof**. A call sitting inside `if (false) { … }`,
 * inside a branch no state can enter, or inside a component nothing renders,
 * satisfies every assertion below. Dead code is a KNOWN residual blind spot of
 * this file and is accepted deliberately: closing it needs a rendering test,
 * which the node-only environment cannot host. Nor does it say anything about
 * layout, paint, event order, or whether the value passed is correct — only
 * that the token appears where executable syntax, rather than prose, can put
 * it.
 *
 * ## Lexical basis
 *
 * The source is parsed with the TypeScript compiler API (`ts.createSourceFile`,
 * `ScriptKind.TSX`) and the assertions run against projections built from the
 * AST, never against raw text. That is what makes "in a comment" and "in a
 * string literal" mean something precise:
 *
 *  - `CALL_SITES` — the text of every `CallExpression`, `JsxAttribute` and JSX
 *    tag name, with a function-valued argument contributing only its header
 *    (see `buildCallSites`). String arguments and attribute values are KEPT,
 *    because a class name passed to `cn(...)` or to a `className=` is
 *    genuinely wiring.
 *  - `SYNTAX` — the whole file with comment ranges blanked, string literals
 *    intact. Used for structural tokens (a `const`, an `if`, a JSX expression)
 *    that are not call arguments, and for the negative assertions.
 *
 * A deliberate deviation from the review directive, stated so it is not
 * mistaken for an oversight: the negative assertions run against `SYNTAX`,
 * which keeps string literals, rather than against a projection that also
 * blanks them. Class-name prohibitions are exactly what string literals carry,
 * and blanking strings would make them vacuous — the failure mode F15 removed
 * from the layout suite. (`max-w-[85%]` and `justify-end` used to be two such
 * negatives; F5 D3-c, 2026-08-18, turned both into required positives on the
 * user bubble, and they are now node-level assertions — see `[D3-1]`.)
 * Comments were the actual leak, and the AST closes that exactly.
 *
 * ## What this costs, stated plainly
 *
 * These assertions match source text. A rename or a refactor will break them
 * WITHOUT anything being wrong, and the correct response is to update the token
 * here after confirming the wiring by hand — not to weaken the assertion.
 */

const FILE = fileURLToPath(new URL('../MessageTimeline.tsx', import.meta.url));
const SOURCE = readFileSync(FILE, 'utf8');

const sourceFile = ts.createSourceFile(
  FILE,
  SOURCE,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX
);

/** Collapse whitespace so a formatter line-break inside a call cannot fail an assertion on its own. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The whole file with every comment blanked and everything else — string
 * literals included — left alone.
 *
 * Comment ranges come from the compiler's own trivia scanner rather than a
 * regular expression. The regex this replaces had two real lexical bugs the
 * review named: a block-comment close sequence inside a string literal would
 * start a false comment, and a line beginning with `//` inside a template
 * literal would be deleted as one. Both are gone by construction — TypeScript
 * attaches every comment as trivia of some token, so walking tokens finds each
 * one exactly where the language says it is.
 */
function buildBlankedSource(): string {
  const chars = SOURCE.split('');
  const blank = (pos: number, end: number) => {
    for (let index = pos; index < end && index < chars.length; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  };
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(SOURCE, node.getFullStart()) ?? []) {
      blank(range.pos, range.end);
    }
    for (const range of ts.getTrailingCommentRanges(SOURCE, node.getEnd()) ?? []) {
      blank(range.pos, range.end);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  for (const child of sourceFile.getChildren(sourceFile)) visit(child);
  return chars.join('');
}

/** Comments blanked once; both projections below are slices of THIS, never of the raw source. */
const BLANKED = buildBlankedSource();

/**
 * Text of every call expression, JSX attribute and JSX tag name.
 *
 * Two things about how this is built are load-bearing, and both were caught by
 * the projection guard below rather than by reasoning:
 *
 *  1. **Sliced out of `BLANKED` by node position**, not read with
 *     `node.getText()`. `getText()` returns the node's whole source span, so a
 *     comment sitting INSIDE a call — an explanatory line in a callback body,
 *     a JSX comment between two attributes — travels with it and lands back in
 *     the haystack.
 *  2. **A function-valued argument contributes its header, never its body.**
 *     `ChatTurn` is declared as `memo(function ChatTurn(…) { … })`, so taking
 *     the full text of that one call would put the ENTIRE component body into
 *     "argument position" and collapse `expectCalled` into `expectWired` for
 *     everything inside it. Calls nested in those bodies are still recorded —
 *     the walk visits them in their own right — so nothing real is lost.
 *
 * Nested nodes appear more than once (a call inside a call), which is
 * harmless — this is a haystack, not a census.
 */
function buildCallSites(): string {
  const parts: string[] = [];
  const slice = (node: ts.Node) => BLANKED.slice(node.getStart(sourceFile), node.getEnd());
  const isFunctionArgument = (node: ts.Node) =>
    ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node);

  const recordCall = (node: ts.CallExpression) => {
    const callee = slice(node.expression);
    if (!node.arguments.some(isFunctionArgument)) {
      parts.push(slice(node));
      return;
    }
    parts.push(`${callee}(`);
    for (const argument of node.arguments) {
      if (!isFunctionArgument(argument)) {
        parts.push(slice(argument));
        continue;
      }
      const name = ts.isFunctionExpression(argument) && argument.name ? argument.name : null;
      parts.push(name ? `${callee}(function ${slice(name)}` : `${callee}(function`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      recordCall(node);
    } else if (ts.isJsxAttribute(node)) {
      parts.push(slice(node));
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      parts.push(`<${slice(node.tagName)}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return parts.join('\n');
}

const CALL_SITES = flatten(buildCallSites());
const SYNTAX = flatten(BLANKED);

/** The token appears in a call expression / JSX attribute / JSX tag position. */
function expectCalled(token: string): void {
  expect(
    CALL_SITES.includes(token),
    `wiring token missing from any call/JSX-attribute position in MessageTimeline.tsx: ${token}`
  ).toBe(true);
}

/** The token appears in executable syntax (comments blanked) — for structural tokens that are not call arguments. */
function expectWired(token: string): void {
  expect(SYNTAX.includes(token), `wiring token missing from MessageTimeline.tsx: ${token}`).toBe(
    true
  );
}

/** The token appears nowhere outside comments. */
function expectUnwired(token: string): void {
  expect(
    SYNTAX.includes(token),
    `wiring token must be gone from MessageTimeline.tsx: ${token}`
  ).toBe(false);
}

/** Occurrences of a literal (not a pattern) in the comment-blanked source. */
function countIn(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Node-level locator (F456 §8.2) — the projections above cannot say WHERE
// ---------------------------------------------------------------------------

/**
 * `expectCalled` / `expectUnwired` answer "does this token appear anywhere in
 * the file", which is the wrong question for a class that must sit on ONE
 * specific element. `expectCalled('flex justify-end')` passes with the class
 * parked on any JSX node in the file; `expectUnwired('bg-card')` demands the
 * token be gone from the WHOLE file when the contract is only about the user
 * bubble. Both are false-precision, and D3-c's contract is entirely positional.
 *
 * The locator below walks the real AST instead: a named top-level function, its
 * root JSX element, then a path of tag names through STRUCTURAL children. A
 * structural child is a JSX element reachable without crossing another JSX
 * element, so a ternary, an `&&`, a `{…}` container and a `.map()` callback are
 * all transparent — which is what makes `['article', 'div', 'div', 'span']`
 * describe the attachment chip regardless of the conditionals wrapping it.
 *
 * `nodeClassName` returns the attribute's LITERAL text and throws otherwise:
 * moving a class string into a variable to dodge these assertions has to fail
 * loudly rather than silently pass.
 */
type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsxNode(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagNameOf(node: JsxNode): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(sourceFile);
}

/** JSX elements reachable from `node` without crossing another JSX element. */
function jsxChildrenOf(node: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(node)) return [];
  const out: JsxNode[] = [];
  const walk = (child: ts.Node): void => {
    if (isJsxNode(child)) {
      out.push(child);
      return;
    }
    ts.forEachChild(child, walk);
  };
  for (const child of node.children) walk(child);
  return out;
}

function firstJsxIn(node: ts.Node): JsxNode | undefined {
  let found: JsxNode | undefined;
  const walk = (candidate: ts.Node): void => {
    if (found) return;
    if (isJsxNode(candidate)) {
      found = candidate;
      return;
    }
    ts.forEachChild(candidate, walk);
  };
  ts.forEachChild(node, walk);
  return found;
}

/**
 * A top-level component, whether it is written as `function X() {}` or as
 * `const X = memo(function X() {})`.
 *
 * The `memo` form is why `ChatTurn`'s child order went unpinned for so long:
 * every locator here used to accept declarations only, so the one component
 * whose layout this batch rearranges was the one component no positional
 * assertion could reach. `memo` is load-bearing on `ChatTurn` (see its head
 * note) and is not going away, so the locator learns the wrapper instead.
 */
function topLevelFunction(fnName: string): ts.FunctionDeclaration | ts.FunctionExpression {
  const declared = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fnName
  );
  if (declared?.body) return declared;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== fnName) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      const wrapped = initializer.arguments[0];
      if (wrapped && ts.isFunctionExpression(wrapped) && wrapped.body) return wrapped;
    }
  }
  throw new Error(
    `no top-level \`${fnName}\` (function or memo(function …)) in MessageTimeline.tsx`
  );
}

/**
 * What the component actually renders: the JSX of its top-level `return`.
 *
 * NOT simply "the first JSX in the body" — `ChatTurn` defines a `renderItem`
 * helper that closes over its props ABOVE the return, so a first-match walk
 * lands on `<TurnItemView>` and every path from there is nonsense. Falls back
 * to the first-match walk for the early-return components that predate this.
 */
function rootJsxOf(fn: ts.FunctionDeclaration | ts.FunctionExpression): JsxNode | undefined {
  const body = fn.body as ts.Block;
  for (const statement of body.statements) {
    if (!ts.isReturnStatement(statement) || !statement.expression) continue;
    let expression: ts.Expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (isJsxNode(expression)) return expression;
  }
  return firstJsxIn(body);
}

/** Walk a tag-name path from the root JSX element of top-level `function fnName`. */
function jsxNodeAt(fnName: string, path: readonly string[]): JsxNode {
  const fn = topLevelFunction(fnName);
  let current = rootJsxOf(fn);
  if (!current) throw new Error(`\`function ${fnName}\` renders no JSX`);
  if (tagNameOf(current) !== path[0]) {
    throw new Error(`${fnName}'s root is <${tagNameOf(current)}>, not <${path[0]}>`);
  }
  for (const [index, segment] of path.slice(1).entries()) {
    const next: JsxNode | undefined = jsxChildrenOf(current).find(
      (child) => tagNameOf(child) === segment
    );
    if (!next) {
      throw new Error(`no <${segment}> under ${fnName} ${path.slice(0, index + 1).join(' > ')}`);
    }
    current = next;
  }
  return current;
}

function classNameInitializerOf(node: JsxNode): NonNullable<ts.JsxAttribute['initializer']> {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const attribute = attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'className'
  );
  if (!attribute?.initializer) throw new Error(`<${tagNameOf(node)}> carries no className`);
  return attribute.initializer;
}

/** The element's `className` as a literal string; throws if it hides behind an expression. */
function nodeClassName(fnName: string, path: readonly string[]): string {
  const initializer = classNameInitializerOf(jsxNodeAt(fnName, path));
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteral(initializer.expression)
  ) {
    return initializer.expression.text;
  }
  throw new Error(`className on ${fnName} ${path.join(' > ')} is not a string literal`);
}

/*
 * `nodeClassNameArgs` — the literal arguments of a `className={cn(…)}` — retired
 * with T12. Its only caller was `[D3-1]`, which read the user bubble's two-part
 * `cn('min-w-0 max-w-[85%] …', 'rounded-br-xs …')`; the bubble now mounts
 * `userBubbleClass()` instead, whose contents are asserted as a return value in
 * `chatTimelineLayout.test.ts` rather than as JSX text.
 */

/** Raw (comment-blanked) text of a node — for subtree prohibitions and expression attributes. */
function nodeSource(node: ts.Node): string {
  return flatten(BLANKED.slice(node.getStart(sourceFile), node.getEnd()));
}

/** First JSX element with `tag` anywhere below `node`, in source order. */
function descendantJsx(node: JsxNode, tag: string): JsxNode {
  let found: JsxNode | undefined;
  const walk = (candidate: ts.Node): void => {
    if (found) return;
    if (isJsxNode(candidate) && tagNameOf(candidate) === tag) {
      found = candidate;
      return;
    }
    ts.forEachChild(candidate, walk);
  };
  ts.forEachChild(node, walk);
  if (!found) throw new Error(`no <${tag}> below <${tagNameOf(node)}>`);
  return found;
}

/** Text of the element's className attribute value, expression and all. */
function classNameExpressionOf(node: JsxNode): string {
  return nodeSource(classNameInitializerOf(node));
}

/** The element's className expression, or `''` when it carries none. */
function classNameExpressionOrEmpty(node: JsxNode): string {
  try {
    return classNameExpressionOf(node);
  } catch {
    return '';
  }
}

/**
 * `ChatTurn`'s `turnBodyClass()` wrapper — the element whose child ORDER FB6
 * rearranges.
 *
 * T12: the section's first child is now a bare `<UserBubble>` with no className
 * of its own (the `turnBubbleBandClass()` wrapper it used to sit in retired), so
 * the search has to tolerate a className-less sibling rather than throw on one.
 */
function turnBodyNode(): JsxNode {
  const section = jsxNodeAt('ChatTurn', ['section']);
  const body = jsxChildrenOf(section).find((child) =>
    classNameExpressionOrEmpty(child).includes('turnBodyClass()')
  );
  if (!body) throw new Error('ChatTurn renders no `turnBodyClass()` child');
  return body;
}

/**
 * Those children, classified by the role each plays in the turn's vertical
 * order. Classification is by the class assembler the child mounts rather than
 * by tag, because the same slot is spelled differently depending on the turn's
 * shape (a `Collapsible` when there is a process segment, a bare `div` when
 * there is not).
 */
function turnBodyChildKinds(): string[] {
  const body = turnBodyNode();
  const kinds: string[] = [];
  for (const child of jsxChildrenOf(body)) {
    const tag = tagNameOf(child);
    // Components carry their classes internally; only the slots this batch
    // rearranges name a class assembler at the call site.
    const attributes = ts.isJsxElement(child) ? child.openingElement.attributes : child.attributes;
    const hasClassName = attributes.properties.some(
      (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'className'
    );
    const className = hasClassName ? classNameExpressionOf(child) : '';
    if (tag === 'RetryBanner') kinds.push('retry');
    else if (className.includes('turnActionsSlotClass()')) kinds.push('actions');
    else if (className.includes('turnHeadClass()')) kinds.push('status');
    else kinds.push(`?${tag}`);
  }
  return kinds;
}

describe('MessageTimeline wiring smoke (F8) — brittle by design', () => {
  // Guards the two projections themselves: if the AST walk silently produced
  // nothing, every positive assertion below would be a false pass — the exact
  // vacuity F15 removed from the layout suite.
  it('the AST projections are non-trivial and comment-free', () => {
    expect(CALL_SITES.length).toBeGreaterThan(1_000);
    expect(SYNTAX.length).toBeGreaterThan(1_000);
    // Prose that exists ONLY in comments. If any of these survive, comment
    // blanking has stopped working and every assertion here is weaker than it
    // reads.
    for (const prose of ['NOT ASSERTABLE', 'reference shot', 'red line', 'A07 :2399']) {
      expect(SYNTAX, `comment prose leaked into SYNTAX: ${prose}`).not.toContain(prose);
      expect(CALL_SITES, `comment prose leaked into CALL_SITES: ${prose}`).not.toContain(prose);
    }
    // `expectCalled` must be strictly narrower than `expectWired`, or the
    // distinction this file is built on is decoration. A plain statement inside
    // `memo(function ChatTurn(…) { … })` is the sharpest case: it is in the
    // file, and it is NOT in call position.
    const statementOnly = "const actionsCopyText = turnActive ? '' : copyText;";
    expect(SYNTAX).toContain(statementOnly);
    expect(CALL_SITES, 'a function body leaked into call position').not.toContain(statementOnly);
    // Negatives keep string literals, or class-name prohibitions mean nothing.
    // (Was `rounded-br-xs`, which T12 moved out of this file into
    // `userBubbleClass()`; the attachment chip's fill is the nearest surviving
    // class literal that is unambiguously code and not prose.)
    expect(SYNTAX, 'string literals must survive for the negatives to bite').toContain(
      'bg-muted/50'
    );
  });

  /**
   * `F1: the head is built by deriveTurnHeadModel` and `the head counts use the
   * compact stats style` both retired with the meta row (T12-b).
   *
   * F1's degradation chain answered "what should a FINISHED turn say about
   * itself when nothing measured a duration". A finished turn now says nothing,
   * so the chain, its compact `deriveTurnStats` argument and the `hasProcess`
   * input went with it (see `turnHead.ts`'s retirement note).
   *
   * What replaces them is below: the one surviving rung is wired straight
   * through, and it is gated on being live.
   */
  it('T12-b: the turn renders the running status directly, and only while running', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn, 'the degradation chain must not come back').not.toContain('deriveTurnHeadModel');
    expectCalled('deriveTurnStatus(');
    // F2's "lost stopwatch": this row going missing while work continues IS the
    // defect, so the gate must be the status itself, never a completion test.
    expect(turn).toContain('{status && (');
    expect(turn).toContain('<TurnStatusContent status={status} />');
  });

  // F2: the in-flight snapshot is bound by evidence, never by "no latency".
  it('F2: the send snapshot is bound by deriveSendStatusBinding', () => {
    expectCalled('deriveSendStatusBinding(');
    expectWired("sendBinding === 'attached'");
    expectWired("sendBinding === 'pending'");
    // The standalone head is what carries the waiting state before the user
    // echo lands; if this stops rendering, the wait is invisible (§3.3).
    expectCalled('<PendingTurnHead');
  });

  // F4: a session failure is attributed, not stamped on whatever is last.
  it('F4: the failed head is gated by ownsSessionFailure', () => {
    expectCalled('failed: ownsSessionFailure(');
    expectUnwired("failed: isLastTurn && sessionStatus === 'failed'");
    // §9-ζ: the session-level failure block keeps its own place and its own
    // condition, below the last turn.
    expectWired("status === 'failed' && (");
  });

  // F2/F4 residue: a restored transcript can end in an unanswered prompt, whose
  // turn is structurally identical to a fresh echo. Both call sites must pass
  // the send-begin baseline, or the shape test decides and the old turn claims
  // the new send's clock and the new send's failure.
  it('F2/F4 residue: both ownership calls receive the send-begin baseline', () => {
    expectCalled('lastTurnUserMessageId: lastTurn?.user?.id ?? null');
    expectCalled('userMessageId: turn.user?.id ?? null');
    expectCalled('baselineKnown: sendBaseline != null');
    expectCalled('baselineMessageId: sendBaseline?.messageId ?? null');
    expectCalled('baselineKnown={sendBaseline != null}');
    expectCalled('baselineMessageId={sendBaseline?.messageId ?? null}');
    expectWired('state.baseline.sessionId === sessionId');
  });

  /**
   * The authorization red line, restated structurally.
   *
   * It used to be conditional: `defaultTurnProcessOpen` force-opened the shell
   * while a permission was unresolved, and the trigger was disabled so the user
   * could not undo it — because a collapsed shell could bury the only Allow/Deny
   * surface in the app (round-2 point-check #5). With the turn-level collapse
   * retired (2026-08-25) there is no shell, so the card cannot be hidden at all.
   *
   * That is a stronger guarantee, but only while the process segment stays
   * unconditional. These three negatives are what keep it that way: no
   * visibility binding, no conditional render, no collapse component.
   */
  it('[FB6-4] the process segment renders unconditionally — nothing can hide a permission card', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn, 'no visibility binding on the panel').not.toContain('hidden={');
    expect(turn, 'the panel is never conditionally rendered').not.toContain(
      "segment.kind === 'process' &&"
    );
    expect(turn, 'and no collapse component came back').not.toContain('<Collapsible');
    // The panel is a plain child of the segment map, spacing and all.
    expectCalled('cn(turnProcessShellClass(), turnBodyClass())');
  });

  // S3 slice 4 (§3.2): the permission card now sends a DECISION, and the
  // allow/deny boolean is derived from it in exactly one place — this lambda.
  //
  // Why it needs a pin here rather than somewhere cheaper: both halves of the
  // wire reply are covered on their own (`permissionDecisionAllows` is truth-
  // tabled in `questionCardModel.test.ts`, the store's outbound payload in
  // `chatSessionsRespond.test.ts`) and NEITHER can tell whether this component
  // joins them. Delete the third argument and every one of those stays green
  // while `Deny and stop` silently degrades into an ordinary deny — the exact
  // shape of blind spot this file's header describes.
  it('S3-4: the permission lambda derives allow from the decision and forwards the decision', () => {
    expectCalled('onRespondPermission={(decision) =>');
    // The single derivation site. A second one would eventually disagree about
    // `allow_session` and draw an "Allowed" card over a wire reply that declined.
    expectCalled('permissionDecisionAllows(decision)');
    // The decision travels as the THIRD argument, immediately after the boolean
    // it produced. Adjacency is the assertion: a bare `decision` token would be
    // satisfied by the lambda's own parameter list.
    expectCalled('permissionDecisionAllows(decision), decision');
    // The boolean-only call this replaced, so a revert cannot pass by adding
    // the third argument back somewhere else in the file.
    expectUnwired("item.block.permissionId ?? '', allow)");
  });

  // F11: the panel needs its own gap or its rows sit flush at 0px while every
  // other pair inside the turn keeps P-17's 10px beat.
  it('F11: the process panel carries the process shell spacing', () => {
    expectCalled('cn(turnProcessShellClass(), turnBodyClass())');
  });

  // F12: `waiting_*` must count as in flight for the shell, or the head and the
  // Collapsible vanish while the authorization card is on screen. The second
  // predicate this file used to fan out (`thinkingCard.isTurnActive`, which
  // excludes `waiting_*`) is deliberately GONE: its last consumer was the
  // Markdown streaming gate, where excluding permission waits flipped Markdown
  // off and back on around every authorization round-trip. Re-introducing it
  // here should trip this test and force that argument to be re-had.
  it('F12: the shell reads isTurnInFlight; isTurnActive stays out of this file', () => {
    expectCalled('isTurnInFlight(status)');
    expectUnwired('isTurnActive(');
    expectWired('!inFlight && isLastTurn && inFlightSession && !turnComplete && firstAssistant');
  });

  // F13: a half-streamed answer must not be silently copyable — the clipboard
  // gives no sign the text was truncated. T12-b moved the button from the meta
  // row to the hover strip; the rule is unchanged, only its host is.
  it('F13: copy is withheld while the turn is in flight', () => {
    expectWired("const actionsCopyText = turnActive ? '' : copyText;");
    expectCalled('<TurnCopyButton');
    expectCalled('text={actionsCopyText}');
    // …and the gate reaches the strip itself, so an in-flight turn shows no
    // empty strip on hover either.
    expectWired('const showActions = actionsCopyText.length > 0;');
  });

  // F7: one flatten per turn, feeding both the render and the copy payload.
  it('F7: the per-second work is scoped to the in-flight turn', () => {
    expectCalled('buildTurnCopyTextFromItems(items)');
    // The double-flatten this replaced. Only assertable because the ChatTurn
    // header, which explains the change and names the old call, is a comment.
    expectUnwired('buildTurnCopyText(turn)');
    expectCalled('memo(function ChatTurn');
    expectCalled('stabilizeTurns(');
    // The two ticking props reach the in-flight turn only.
    expectCalled('nowMs={isLastTurn ? nowMs : STATIC_NOW_MS}');
    expectCalled('sendStatus={isLastTurn ? attachedSendStatus : null}');
  });

  /**
   * `F9: the footer reads an injected clock` retired with the meta row (T12-b).
   *
   * F9 existed because the footer printed a RELATIVE age and nothing re-renders
   * an idle transcript, so every age froze at whatever it was when the last
   * token landed. The hover strip prints an absolute `HH:MM`, which stays
   * correct forever without a clock — so F9's defect class cannot recur here,
   * and this is what says the relative form did not sneak back in with its
   * stale-clock problem attached.
   */
  it('T12-b: the strip shows an absolute clock, so no ticking clock is needed', () => {
    expectCalled('formatAbsoluteTime(metadata.completedAt)');
    for (const gone of ['useMinuteTick', 'footerNowMs', 'formatRelativeTimestamp']) {
      expect(SYNTAX, `the relative-age apparatus must not return: ${gone}`).not.toContain(gone);
    }
  });

  /**
   * T12 (replaces §5's band assertions). The bubble now renders through three
   * class functions and no wrapper: `userBubbleRowClass()` aligns it,
   * `userBubbleClass()` shapes it, `userBubbleTextClass()` sets the prose.
   *
   * The negatives are the load-bearing half. `turnBubbleBandClass` was the
   * `position: sticky` band, and the two `fx-` hooks were the scroll-state
   * query container that made the clamp pinned-only. All three are gone, and
   * they must stay gone TOGETHER: bringing the band back without the rest
   * re-creates F10's oscillation (scroll position -> clamp -> height -> scroll
   * position), which is the whole reason the clamp existed in the first place.
   */
  it('T12: the bubble renders through its class functions, with no sticky band', () => {
    expectCalled('userBubbleRowClass()');
    expectCalled('userBubbleClass()');
    expectCalled('userBubbleTextClass()');
    expect(SYNTAX, 'the sticky band must not return (T12)').not.toContain('turnBubbleBandClass');
    expect(SYNTAX, 'fx-turn-band must not return (F10)').not.toContain('fx-turn-band');
    expect(SYNTAX, 'fx-turn-bubble-text must not return (F10)').not.toContain(
      'fx-turn-bubble-text'
    );
    // The clamp and its toggle retired with the band — see `userBubbleClass()`.
    expect(SYNTAX, 'the prompt clamp must not return on its own').not.toContain('line-clamp');
    expect(SYNTAX, 'the Show more toggle retired with the clamp').not.toContain('Show more');
  });

  // T-29: assistant prose is Markdown, and it is Markdown in exactly ONE place.
  //
  // This test is the reason the render point could be identified at all: the
  // task brief pointed at `:686`/`:711` as the assistant text sites, and both
  // turned out to be something else (the user bubble's prompt echo and
  // `NoticeMessage`'s alert body). The real one is `TurnItemView`'s `text`
  // branch, which serves BOTH turn segments. These assertions pin that, so a
  // future edit that "helpfully" markdowns the other two fails here.
  it('T-29 / FB1-b: markdown renders in ONE component, and only from prose', () => {
    // The gate reads the streaming-block id the timeline already derives — not
    // a new store field (`chatSessions.ts` is a red line) and not a shape test.
    expectCalled('shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })');
    expectCalled('<ChatMarkdown');
    // FB1-b split the ONE render site into two, both inside `TurnTextItem`: the
    // settled-segment map and the whole-text branch for a block that is not
    // streaming. The claim that mattered is unchanged and is now stated as
    // containment — the user bubble, the notices and the tool rows are still
    // nowhere near markdown.
    const prose = nodeSource(topLevelFunction('TurnTextItem'));
    expect(
      (CALL_SITES.match(/<ChatMarkdown/g) ?? []).length,
      'markdown renders from TurnTextItem and nothing else'
    ).toBe((prose.match(/<ChatMarkdown/g) ?? []).length);
    for (const other of ['UserBubble', 'NoticeMessage']) {
      expect(
        nodeSource(topLevelFunction(other)),
        `${other} must not render markdown`
      ).not.toContain('<ChatMarkdown');
    }
    // Unparsed prose still has exactly one spelling, shared by the streaming
    // tail and the pre-gate block.
    expectCalled(
      'className="text-markdown leading-relaxed text-foreground whitespace-pre-wrap select-text"'
    );
    // The bubble's own prompt echo (`:845`) reads at the same rhythm but is a
    // different element with a different class order, so the count is of THIS
    // string — assistant prose that has not been parsed.
    const proseClass =
      'text-markdown leading-relaxed text-foreground whitespace-pre-wrap select-text';
    expect(
      CALL_SITES.split(proseClass).length - 1,
      'one definition of how unparsed assistant prose reads'
    ).toBe(1);
  });

  /**
   * FB1-b's own wiring. The pure functions were proved in isolation a slice
   * earlier; these three lines are what actually makes them run.
   *
   * The high-water mark is the whole point: `splitClosedPrefix` is stateless and
   * may return a SHORTER settled prefix than it did a token ago, which on screen
   * is formatted text flashing back to plain. `advanceClosedPrefix` is the
   * monotonic entry point, and it has to be the one called here.
   */
  it('[FB1-4] the progressive renderer is driven by text alone — no clock, no store', () => {
    const prose = nodeSource(topLevelFunction('TurnTextItem'));
    expect(prose, 'the monotonic entry point, not the stateless one').toContain(
      'advanceClosedPrefix(text, closedHwmRef.current)'
    );
    expect(prose).not.toContain('splitClosedPrefix(');
    // R3: re-cutting is driven by new tokens arriving, never by a timer. A
    // periodic re-cut would re-create the "change a prop every second and lose
    // `React.memo`" defect this file already carries a note about.
    for (const banned of ['setInterval', 'setTimeout', 'Date.now', 'nowMs']) {
      expect(prose, `${banned} must not drive the split`).not.toContain(banned);
    }
    // R5: no store, no new prop on the turn.
    expect(prose).not.toContain('useChatSessionsStore');
  });

  /**
   * The other half of `[FB1-6]`, and the reason it needs one.
   *
   * `[FB1-6]` proves the MODEL hands out linear work: `advanceClosedPrefix`
   * returns settled text already cut into segments, each of which is parsed once
   * and then memo-hits on its unchanged string. It cannot see what the RENDER
   * does with them — re-joining the segments into a single `<ChatMarkdown>`
   * produces identical output, leaves every pure-function assertion green, and
   * re-parses the whole settled prefix on every flush. Measured on a 100KB
   * answer over 40 flushes: 6379ms joined against 165ms segmented.
   */
  it('[FB1-7] settled segments render one <ChatMarkdown> each, never re-joined', () => {
    const prose = nodeSource(topLevelFunction('TurnTextItem'));
    expect(prose).toContain('split.segments.map(');
    expect(prose, 'one element per segment, keyed by its own content').toContain(
      '<ChatMarkdown key={segment} text={segment} />'
    );
    expect(prose, 'the joined shape is the whole defect').not.toMatch(/segments\s*\.join\(/);
  });

  /**
   * T12-c (user decision, 2026-08-30: 按 pi-app 的来). The model can hand back
   * an `openFence` and nothing on screen would change if the render dropped it
   * — every pure-function assertion in `piMarkdownSplitComparison.test.ts`
   * stays green, because they only ever call the splitter.
   */
  it('[FB1-8] a streaming code fence is rendered as Markdown, and separately from the settled segments', () => {
    const prose = nodeSource(topLevelFunction('TurnTextItem'));
    expect(prose, 'the open fence must reach the parser').toContain(
      '<ChatMarkdown text={split.openFence} />'
    );
    // It must NOT be keyed by content: this chunk is meant to update in place
    // as it grows. A content key would remount the code block on every token,
    // which is a new mount (and a lost scroll/selection) per flush.
    expect(prose).not.toContain('key={split.openFence}');
    // And the plain tail must still exist — the prose before a fence is still
    // in flight and must not be parsed.
    expect(prose).toContain('<PlainProse text={split.openTail} />');
  });

  /**
   * The segment container's key. `hwm` lives in a `useRef` on `TurnTextItem`,
   * so the component instance has to survive a cut point moving; an index key
   * on the SEGMENT list would be fine (segments are append-only), but an index
   * key on the turn's segment containers would remount this subtree whenever a
   * tool group landed before it — hwm back to zero, settled text back to plain.
   * That failure is invisible to every static check except this one.
   */
  it('[FB1-5] turn segment containers are keyed by identity, never by index', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn).toContain('turnItemKey(segment.items[0])');
    expect(turn, 'no bare index key on a segment container').not.toMatch(/key=\{index\}/);
  });

  // Selection opt-in: `globals.css` sets `user-select: none` on `*`, so every
  // content surface must carry `.select-text` or the transcript can only be
  // copied through the copy button (found in T-29 GUI review). Chrome — turn
  // heads, triggers, status rows — deliberately stays non-selectable, which is
  // why this is pinned per surface instead of once on the timeline root.
  it('message content opts back into text selection', () => {
    // The user bubble's `select-text` moved into `userBubbleTextClass()`
    // (asserted in `chatTimelineLayout.test.ts`); the wiring half is the §5
    // call assertion above.
    expectCalled('className="select-text whitespace-pre-wrap text-markdown text-foreground"');
  });

  // The three surfaces T-29 deliberately does NOT touch. Each is model-adjacent
  // enough that "add markdown here too" is a plausible future edit, and each has
  // a reason not to: the user bubble is the operator's own prompt under an
  // unconditional line clamp (F10), a notice is an `Alert` body, and tool
  // IN/OUT is a mono transcript.
  it('T-29: user bubble and notice bodies stay plain text', () => {
    // Both paragraphs still exist and still pre-wrap. The class-string order is
    // what distinguishes them from `TurnItemView`'s streaming fallback, which
    // spells the same utilities in the opposite order (`text-markdown` first).
    //
    // These used to be counted through their shared `whitespace-pre-wrap
    // text-markdown` prefix. D3-c inserted `break-words` into the user bubble's
    // string (§3.2's `min-width: auto` pair), so the prefix is no longer shared
    // and each paragraph is now pinned as a whole string — strictly stronger
    // than the prefix count it replaces, and it still fails if either is
    // deleted or routed into markdown.
    for (const cls of [
      'whitespace-pre-wrap break-words text-markdown leading-relaxed text-foreground',
      'select-text whitespace-pre-wrap text-markdown text-foreground',
    ]) {
      expect(countIn(SYNTAX, cls), `paragraph must survive verbatim: ${cls}`).toBe(1);
    }
  });

  // F13's sibling: the copy payload is the RAW markdown source, so the button
  // keeps yielding what the model wrote rather than the rendered text. T-29
  // changes nothing here, and this assertion is what says so.
  it('T-29: copy still ships the raw markdown source', () => {
    expectCalled('buildTurnCopyTextFromItems(items)');
  });

  /**
   * `[D3-1]`, rewritten for T12. The claim is unchanged in kind — the bubble is
   * right-aligned, capped and shaped — but WHERE it is stated moved: the two
   * inline literals this used to read (`'flex justify-end'` and the `cn(…)`
   * pair) are now `userBubbleRowClass()` / `userBubbleClass()`, whose contents
   * `chatTimelineLayout.test.ts` asserts directly.
   *
   * So this half asserts the WIRING — that the bubble mounts those two
   * functions and nothing hand-rolled — which is the part a node-environment
   * suite can only see through the AST. Splitting it this way is strictly
   * stronger than the old form: the class contents are now checked as return
   * values rather than as JSX text, so a `cn(…)` argument reordering can no
   * longer break the test without breaking anything real.
   */
  it('[D3-1] T12: the bubble mounts its row and box classes, not inline literals', () => {
    // ① the row the bubble sits at the end of, and ② the box itself.
    expect(classNameExpressionOf(jsxNodeAt('UserBubble', ['article']))).toBe(
      '{userBubbleRowClass()}'
    );
    expect(classNameExpressionOf(jsxNodeAt('UserBubble', ['article', 'div']))).toBe(
      '{userBubbleClass()}'
    );
    // ③ the prose that has to break — the other half of the cap: a flex item's
    //    `min-width` resolves to `auto` and outranks `max-width`, so without a
    //    break opportunity one long URL takes the bubble full width again.
    //    Plus D1-b's line height (the bubble reads at assistant-prose rhythm).
    const body = classNameExpressionOf(
      descendantJsx(jsxNodeAt('UserBubble', ['article', 'div']), 'p')
    );
    expect(body).toContain('break-words');
    expect(body).toContain('leading-relaxed');
    // …and the hover strip that replaced the meta row is a different element.
    expectCalled('turnActionsSlotClass()');
  });

  // The subtree form is required: `expectUnwired('bg-card')` would demand the
  // token be gone from the WHOLE file, which is a different (and wrong)
  // contract — `bg-card` is legitimate elsewhere in the timeline.
  it('[D3-2] the bubble no longer sits on the card surface', () => {
    expect(nodeSource(topLevelFunction('UserBubble'))).not.toContain('bg-card');
  });

  // On `bg-card` the chip's `border-border` measured ≈1.36; on `bg-accent` it
  // drops to 1.115 in dark, i.e. effectively invisible. It follows the bubble's
  // own edge onto `--input` (§3.4 ③).
  it('[D3-3] the attachment chip edge follows the bubble onto --input', () => {
    const chip = nodeClassName('UserBubble', ['article', 'div', 'div', 'span']);
    expect(chip).toContain('border border-input');
    expect(chip).not.toContain('border-border');
  });

  /**
   * `[D3-8]`, restated for T12. It used to protect the six-line clamp's line
   * budget from being spent on attachment chips. There is no clamp any more,
   * but the separation it enforced is still load-bearing for a second reason:
   * `userBubbleTextClass()` carries `select-text`, and the chips are metadata,
   * not prose. Folding the strip inside the prose container would silently make
   * a "copy the prompt" drag select filenames as if the operator had typed
   * them. FB3's third child — the `Show more` toggle — is gone with the clamp.
   */
  it('[D3-8] the prose container holds paragraphs only, never the attachment chips', () => {
    const children = jsxChildrenOf(jsxNodeAt('UserBubble', ['article', 'div']));
    expect(children.map(tagNameOf), 'attachment strip, prose, then pending status').toEqual([
      'div',
      'div',
      'div',
    ]);
    expect(classNameExpressionOf(children[0])).toContain('flex flex-wrap');
    expect(classNameExpressionOf(children[1])).toBe('{userBubbleTextClass()}');
    expect(classNameExpressionOf(children[2])).toContain('text-muted-foreground');
    const prose = jsxChildrenOf(children[1]);
    expect(prose.map(tagNameOf), 'the prose container holds paragraphs and nothing else').toEqual([
      'p',
    ]);
    expect(nodeSource(children[1])).toContain('textBlocks.map(');
    expect(nodeSource(children[1])).not.toContain('attachment');
  });

  // `turnBodyClass()` appears three times in `ChatTurn` (turn body, process
  // panel, answer) and the three call sites read almost identically, so "the
  // container is called once" is not evidence of WHERE. The guard expression is.
  /**
   * `[FB4-7]`, inverted by T12. It used to pin WHERE the answer container was
   * mounted (the `answer` branch and nowhere else). The container is gone, so
   * the claim becomes a prohibition: no segment branch draws a box.
   *
   * Stated over the whole `renderSegment` body rather than over one branch,
   * because the failure this now guards is a re-introduction anywhere — the
   * process branch is just as tempting a home for "let's put a border around
   * the tool runs" and would land the same "everything is a card" result the
   * asymmetry was chosen to avoid.
   */
  it('[FB4-7] no segment branch wraps its content in a container', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn, 'the retired answer ring must not come back').not.toContain(
      'turnAnswerContainerClass'
    );
    const renderSegment = turn.slice(
      turn.indexOf('const renderSegment ='),
      turn.indexOf('return (\n    <section')
    );
    expect(
      renderSegment.length,
      'the slice must be non-trivial or this proves nothing'
    ).toBeGreaterThan(200);
    for (const box of ['border-border', 'rounded-sm', 'bg-muted', 'bg-card', 'shadow-']) {
      expect(renderSegment, `a segment branch grew a container: ${box}`).not.toContain(box);
    }
    // The process branch keeps its own shell — spacing only, no face, no edge.
    expect(renderSegment).toContain('cn(turnProcessShellClass(), turnBodyClass())');
  });

  /**
   * FB6's zero-regression net, and the reason this batch had to build one.
   *
   * Nothing pinned `ChatTurn`'s child ORDER before: the suite runs on
   * `environment: 'node'` with no jsdom, and every positional locator here
   * rejected `memo(function …)` — which is exactly how `ChatTurn` is written.
   * Moving the head from the top of the turn to the bottom passed the entire
   * suite untouched. This was landed as a temporary `[FB6-0]` pinning the OLD
   * order first, watched go red when the structure moved, and only then
   * rewritten into the permanent claim below.
   *
   * The claim: everything the model produced comes first, and the row that
   * TALKS about the turn comes last. "Worked for 12s" belongs under the output
   * it describes, not above it.
   */
  it('[FB6-1] every content segment precedes the trailing status and action rows', () => {
    const kinds = turnBodyChildKinds();
    // FB6's claim, unchanged by T12-b: everything the model produced comes
    // first, and the rows that TALK about the turn come last. What changed is
    // WHICH rows those are — the single meta row split back into a live-only
    // status row and a hover action strip.
    expect(kinds).toContain('status');
    expect(kinds).toContain('actions');
    expect(kinds.filter((kind) => kind === 'status')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'actions')).toHaveLength(1);
    // The strip is last, and the status sits immediately above it.
    expect(kinds.indexOf('actions'), 'the action strip is last').toBe(kinds.length - 1);
    expect(kinds.indexOf('status')).toBe(kinds.length - 2);
    // …and nothing chrome-like survives ABOVE the content (`retry` is a banner
    // about the reply in progress, not a summary of it).
    expect(kinds.slice(0, -2).every((kind) => kind === 'retry' || kind.startsWith('?'))).toBe(true);
  });

  /**
   * `[FB6-5]`, carried over to the strip that replaced the meta row.
   *
   * The row holds a control, so it must never itself become a `<button>` — a
   * button cannot contain a button. This was live once: the original FB6 sketch
   * made the whole row the collapse trigger, which would have nested copy
   * inside it. The collapse is gone; copy is not, and now it sits inside two
   * nested divs whose only jobs are the reveal and the clipping.
   */
  it('[FB6-5] the action strip is a container, not a control', () => {
    const strip = jsxChildrenOf(turnBodyNode()).find((child) =>
      classNameExpressionOrEmpty(child).includes('turnActionsSlotClass()')
    );
    if (!strip) throw new Error('ChatTurn renders no `turnActionsSlotClass()` strip');
    expect(tagNameOf(strip), 'the slot itself must not be a button').toBe('div');
    const inner = jsxChildrenOf(strip);
    expect(inner.map(tagNameOf)).toEqual(['div']);
    expect(classNameExpressionOrEmpty(inner[0])).toContain('turnActionsInnerClass()');
    expect(tagNameOf(inner[0]), 'the inner row must not be a button either').toBe('div');
  });

  /**
   * ⚠️ RETIRED with the turn-level collapse (2026-08-25, user decision):
   * `[FB6-6]` (every panel reads one shared open state), `[FB6-7]` (stable
   * `useId` panel ids enumerated by the trigger's `aria-controls`), `[FB6-8]`
   * (the trigger is actually wired to a toggle, not merely labelled with one)
   * and the old `[FB6-4]` (the permission lock rides the new trigger).
   *
   * All four described a control that no longer exists. What they were
   * protecting — that a pending Allow/Deny card can never be collapsed away —
   * is now `[FB6-4]` above, and it holds structurally instead of by wiring.
   *
   * `[FB6-8]` is worth remembering for the next control this file grows: it
   * existed because the first cut of that trigger carried correct
   * `aria-expanded` / `aria-controls` / `disabled` and no `onClick` at all, and
   * every attribute assertion passed over a dead button. A screenshot caught
   * it, not this suite.
   */

  // T-33: the retry banner is derived by the pure function and mounted in BOTH
  // head slots — the attached last turn and the pending head. Without the
  // second mount the handshake window (retry before the user echo lands) shows
  // nothing, which is exactly the wait the banner exists to explain.
  it('T-33: the retry banner is wired into the last turn and the pending head', () => {
    // ChatTurn feeds the real gate inputs…
    expectCalled('inFlight: inFlightSession');
    expectCalled('outputSinceRetry: turnProgressStamp > progressStampAtRetry');
    // …the pending head's are literals, because its existence is the proof.
    expectCalled('deriveRetryBanner({ retry, inFlight: true, outputSinceRetry: false })');
    // F1 (Codex review, two rounds): the disproof is "new output SINCE this
    // retry", never "the turn ever had output" — and the stamp counts
    // CHARACTERS, not just blocks, because recovery may append into an
    // existing text block without growing the count.
    expectWired('const progressStampAtRetry = useMemo(() => turnProgressStamp, [retry]);');
    expectWired('sum + 1 + (block.text?.length ?? 0)');
    expectUnwired('outputSinceRetry: turnHasBlocks');
    expectUnwired('outputSinceRetry: turnBlockCount > blockCountAtRetry');
    expect(
      (CALL_SITES.match(/<RetryBanner/g) ?? []).length,
      'the banner must render in exactly the two head slots'
    ).toBe(2);
    // A retry tick must not re-render every turn in the session: the prop is
    // narrowed to the one turn that can show it, like the two ticking props.
    expectCalled('retry={isLastTurn && pendingSendStatus == null ? sessionRetry : null}');
    // The pending head keeps rendering when EITHER piece exists.
    expectWired('if (!status && !retryBanner) return null;');
  });

  // The `✽` glyph is applied at exactly one `.tsx` render site, never inside
  // the pure `turnStatus.ts` module, per that file's own copy/decoration split.
  it('the ✽ glyph is a .tsx-only decoration, gated on the streaming kind', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning literal source text, not writing a template string
    expectWired("status.kind === 'streaming' ? `✽ ${status.text}` : status.text");
  });

  // The live `↓` token counter was retired along with the Claude host's interim
  // usage channel (T35): Pi reports usage only at `turn_end`, so nothing can
  // state a reply's size while the reply is still arriving. Settled per-turn
  // totals live on the Run surface instead. This guard keeps the counter from
  // being reintroduced against an estimate.
  it('does not read a live output-token estimate from the runtime-facts store', () => {
    expect(SOURCE).not.toContain('turnTokensDisplay');
    expect(SOURCE).not.toContain('outputTokensDisplay');
  });
});

/**
 * T-29 review batch addendum (adversarial re-review): the "exactly ONE markdown
 * render site" assertion above counts `<ChatMarkdown` inside `CALL_SITES`, which
 * is built from THIS file's own AST. The claim it backs — "assistant prose is
 * Markdown in exactly one place in the whole app" — is a repo-wide claim, and
 * the single-file count cannot falsify a violation living anywhere else. Proven
 * by demonstration during review: dropping `import { ChatMarkdown } from
 * './ChatMarkdown';` plus a render into an unrelated component leaves every
 * assertion above green.
 *
 * This closes the gap with an independent filesystem walk over `src/`, outside
 * MessageTimeline.tsx's own AST entirely. `ChatMarkdown` may be imported or
 * referenced as an identifier nowhere except its own module (excluded from the
 * scan) and `MessageTimeline.tsx`.
 *
 * The identifier check reuses the same "AST, not text" discipline as the rest
 * of this file: comments never become AST nodes, and string-literal text lives
 * on a `StringLiteral`, never an `Identifier`, so walking for `ts.isIdentifier`
 * nodes tells a real reference from a comment mention or an import-path string
 * without any manual comment-blanking.
 */
describe('T-29 repo-wide: ChatMarkdown has exactly one call site in src/', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

  /** Recursively collect every `.ts`/`.tsx` file under `dir`. */
  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectTsFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * Whether `name` appears as a real identifier (import specifier, JSX tag,
   * value reference) in `file` — never in a comment or a string literal. A
   * cheap substring pre-filter skips the AST parse for files that cannot
   * possibly match, since every `Identifier` is a substring hit first.
   */
  function fileUsesIdentifier(file: string, name: string): boolean {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(name)) return false;
    const fileAst = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === name) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fileAst);
    return found;
  }

  const files = collectTsFiles(SRC_ROOT)
    .filter((file) => !/[/\\]__tests__[/\\]/.test(file))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => path.basename(file) !== 'ChatMarkdown.tsx');

  it('the scanned file list is non-trivial, or the guard below is vacuous', () => {
    expect(files.length).toBeGreaterThan(100);
    // Negative control, exercised for real rather than asserted in the abstract:
    // `chatMarkdownPolicy.ts` names "ChatMarkdown" three times, all in prose
    // comments (see this file's own header, which names it too). It must be
    // IN the scanned set and NOT in the offenders below, or the identifier
    // walk has degraded into a text search.
    const policyFile = path.join(SRC_ROOT, 'renderer/components/chat/chatMarkdownPolicy.ts');
    expect(files).toContain(policyFile);
    expect(fileUsesIdentifier(policyFile, 'ChatMarkdown')).toBe(false);
  });

  it('only MessageTimeline.tsx imports or references the ChatMarkdown identifier', () => {
    const offenders = files
      .filter((file) => fileUsesIdentifier(file, 'ChatMarkdown'))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'));

    expect(
      offenders,
      'ChatMarkdown must be imported/referenced nowhere under src/ except MessageTimeline.tsx ' +
        '(its own module is excluded from the scan)'
    ).toEqual(['renderer/components/chat/MessageTimeline.tsx']);
  });
});

/**
 * F5 D1-b `[INV-D1-1]`: the prose density change is asserted as a pair of
 * counts, because either half alone is blind.
 *
 * There is NO token propagation between the three prose surfaces: `text-markdown`
 * carries the 15px size only, and every line height in this directory is spelled
 * as its own literal class. So changing the markdown root does not drag the user
 * bubble or the streaming fallback along, and nothing stops a future edit from
 * moving one and forgetting the others — or from moving all nine at once.
 *
 * A presence check ("`leading-relaxed` appears") cannot see either failure. Two
 * counts asserted together can: the positive count catches the missed surface,
 * and the negative count catches the over-applied one. The six that must stay
 * on `leading-normal` are the reverse gate — they are UI elements (`QuestionCard`
 * ×3, `ToolRows`' single-line rows, `turnBodyClass()`'s inherited baseline, and
 * `EnhancedInput`'s textarea), not long-form prose, and D1-b was authorised for
 * prose only.
 */
describe('[INV-D1-1] F5 D1-b: the three prose surfaces move together, the rest do not', () => {
  const CHAT_DIR = path.dirname(FILE);

  function chatSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...chatSourceFiles(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const CHAT_FILES = chatSourceFiles(CHAT_DIR);
  /** Comments stripped: every line height quoted in prose below would otherwise be counted. */
  const CHAT_CODE = CHAT_FILES.map((file) => stripComments(readFileSync(file, 'utf8'), file)).join(
    '\n'
  );

  it('the scanned corpus is non-trivial, or both counts below are vacuous', () => {
    expect(CHAT_FILES.length).toBeGreaterThan(20);
    expect(CHAT_CODE.length).toBeGreaterThan(10_000);
    // Comment stripping is load-bearing here: `chatTimelineLayout.ts` quotes
    // `leading-normal` in the doc comment that explains why it keeps it.
    expect(CHAT_CODE).not.toContain('comes from that same article');
  });

  it('exactly the three prose surfaces carry the 1.625 tier', () => {
    expect(countIn(CHAT_CODE, 'leading-relaxed'), 'root + user bubble + streaming fallback').toBe(
      3
    );
    // Spelled out so a failure names the surface, not just the count.
    expect(CHAT_CODE).toContain('break-words text-markdown leading-relaxed text-foreground');
    expect(CHAT_CODE).toContain(
      'whitespace-pre-wrap break-words text-markdown leading-relaxed text-foreground'
    );
    expect(CHAT_CODE).toContain(
      'text-markdown leading-relaxed text-foreground whitespace-pre-wrap select-text'
    );
  });

  it('the six non-prose surfaces are still on 1.5, and so is the turn skeleton', () => {
    // Six kept surfaces + the code block, which D1-b moved UP to 1.5 from
    // `leading-snug` (§1.2 ⑥) and therefore joins this count rather than the
    // one above. Both numbers move if anyone applies the change wholesale.
    expect(countIn(CHAT_CODE, 'leading-normal'), 'six UI surfaces + the code block').toBe(7);
    // The skeleton itself: `turnBodyClass()` feeds components that set no size
    // of their own, so relaxing it would resize `QuestionCard` and the tool
    // shells — outside D1-b's authorisation.
    expect(CHAT_CODE).toContain('flex flex-col gap-2.5 text-markdown leading-normal');
    expect(CHAT_CODE).toContain('text-left text-markdown leading-normal');
  });
});
/**
 * `[FB3-*]`, retired and replaced by T12.
 *
 * FB3 added a user-owned `Show more` toggle to lift F10's unconditional
 * six-line clamp on the prompt. T12 removed the clamp itself — it existed only
 * to stop the sticky band's scroll-position -> height oscillation, and there is
 * no sticky band any more — so there is nothing left for a toggle to lift, and
 * `[FB3-2]` / `[FB3-3]` have no subject.
 *
 * The INVARIANT they carried is the part worth keeping, and it is the reason
 * this block still exists rather than being deleted: whatever ends up sizing the
 * prompt must never be a function of geometry. `[FB3-2]` pinned that by
 * inspecting the argument to `userBubbleTextClass`; with the argument gone, the
 * strongest available form is that the bubble subtree reads no geometry at all.
 */
describe('T12: the prompt bubble reads no geometry (the invariant FB3 carried)', () => {
  it('T12: nothing in UserBubble measures the DOM or the scroll position', () => {
    const bubble = nodeSource(topLevelFunction('UserBubble'));
    expect(bubble.length, 'the slice must be non-trivial or this proves nothing').toBeGreaterThan(
      200
    );
    for (const probe of [
      'getBoundingClientRect',
      'IntersectionObserver',
      'ResizeObserver',
      'scrollHeight',
      'clientHeight',
      'offsetTop',
      'useRef',
    ]) {
      expect(bubble, `the prompt must not be sized by geometry: ${probe}`).not.toContain(probe);
    }
  });

  // The class function is now a constant, so "driven by user intent" degrades
  // to "driven by nothing" — which is strictly safer and is what this pins.
  it('T12: userBubbleTextClass is called with no argument at all', () => {
    const calls = [...SYNTAX.matchAll(/userBubbleTextClass\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      expect(argument.trim()).toBe('');
    }
  });
});

/**
 * T12-d — the bottom anchor.
 *
 * The pure decision (`shouldShowJumpToBottom`) is truth-tabled in
 * `messageTimelineScroll.test.ts`. This block covers the layer that file
 * cannot: that the component actually reaches for it, from BOTH places that
 * can change the answer, and that the button it paints is not the shape this
 * timeline has spent several batches proving it must not have.
 */
describe('T12-d: the jump-to-bottom button', () => {
  const timeline = nodeSource(topLevelFunction('MessageTimeline'));

  it('the visibility decision comes from the shared predicate, not a second copy', () => {
    expectCalled('shouldShowJumpToBottom(');
    // The threshold lives in the pure module; a literal here would be a second
    // answer to "how far is far enough", free to drift from the first.
    expect(timeline, 'no inline threshold literal').not.toContain('140');
  });

  /**
   * Both writers are load-bearing and they cover disjoint cases. A scroll
   * event alone misses the one that matters most: while the user reads history
   * during a live turn the viewport never moves, so only content growth —
   * seen by the ResizeObserver — can reveal that the live end has run away.
   */
  it('is synced from both the scroll handler and the growth observer', () => {
    const syncs = [...timeline.matchAll(/syncJumpToBottom\(viewport\)/g)];
    expect(syncs.length, 'scroll alone leaves a streaming turn without a button').toBe(2);
  });

  it('the click re-arms the follower — the one place allowed to', () => {
    const jump = timeline.slice(timeline.indexOf('const jumpToBottom'));
    const body = jump.slice(0, jump.indexOf('}, []);') + 7);
    expect(body).toContain('stickToBottomRef.current = true');
    expect(body).toContain('viewport.scrollTop = viewport.scrollHeight');
    // Written BEFORE the scroll event this provokes, so `nextFollowState` sees
    // an unchanged height at the bottom and agrees instead of overwriting.
    expect(body.indexOf('lastScrollHeightRef.current')).toBeLessThan(
      body.indexOf('viewport.scrollTop =')
    );
  });

  it('a session switch clears the affordance instead of inheriting it', () => {
    expect(timeline).toContain('setShowJumpToBottom(false)');
  });

  /**
   * The button is positioned against the WRAPPER, not the scrollport. Inside
   * the viewport an absolute child scrolls away with the content and a sticky
   * one is the exact shape `chatTimelineLayout.ts` prohibits after F10.
   */
  it('renders outside the scrollport and carries no sticky/fixed hook', () => {
    const anchorIndex = timeline.indexOf('showJumpToBottom && (');
    expect(anchorIndex).toBeGreaterThan(timeline.indexOf('</ScrollArea>'));
    const button = timeline.slice(anchorIndex);
    expect(button).toContain('absolute right-3 bottom-3');
    expect(button, 'sticky must not come back through this door').not.toMatch(
      /(?:^|\s)(?:sticky|fixed)(?:\s|-)/
    );
  });

  /**
   * `F-B15` reversed the "never hover-only" red line for the turn action strip,
   * on the argument that its actions exist elsewhere too. That argument does
   * not transfer: this button is the ONLY way back to a running stream, so it
   * stays a real, focusable control whose visibility is geometry alone.
   */
  it('is a real button, labelled, and never gated on hover', () => {
    const button = timeline.slice(timeline.indexOf('showJumpToBottom && ('));
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label={t(');
    for (const banned of ['group-hover', 'opacity-0', 'invisible']) {
      expect(button, `the anchor must not be hover-gated: ${banned}`).not.toContain(banned);
    }
  });
});

/**
 * T12-d — the tool-row expand memory needs a session to key on, and the ONLY
 * way it reaches `ToolRows.tsx` is this prop chain. Every hop is asserted:
 * dropping any one of them leaves the rows silently unremembered, which is
 * precisely the failure `subagentWiring.test.ts` cannot see from the other end.
 */
describe('T12-d: sessionId reaches the tool rows', () => {
  /**
   * Asserted hop BY hop, inside the element that performs it. A file-wide
   * count is not enough and the first draft of this test proved it: dropping
   * the `ChatTurn` hop left four other `sessionId={sessionId}` attributes
   * standing — `HistoryErrorNotice` carries one too — so the count stayed
   * satisfied while the chain was broken at its first link.
   */
  it.each([
    ['MessageTimeline', 'ChatTurn'],
    ['ChatTurn', 'TurnItemView'],
    ['TurnItemView', 'ToolGroupItem'],
  ])('%s forwards sessionId to <%s>', (parent, child) => {
    const source = nodeSource(topLevelFunction(parent));
    const element = new RegExp(`<${child}\\b[^>]*>`, 's').exec(source);
    expect(element, `no <${child}> element found in ${parent}`).not.toBeNull();
    expect(
      (element as RegExpExecArray)[0],
      `a dropped hop leaves every tool row below it silently unremembered`
    ).toContain('sessionId={sessionId}');
  });

  it('the group receives it at the single ToolGroup call site', () => {
    const toolGroupItem = nodeSource(topLevelFunction('ToolGroupItem'));
    expect(toolGroupItem).toContain('<ToolGroup rows={rows} sessionId={sessionId} />');
  });
});
