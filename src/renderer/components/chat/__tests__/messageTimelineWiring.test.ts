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
    // F7b widened the gate: the pending head owns the running status while a
    // send's user echo has not landed, so the turn must yield to it too — see
    // messageTimelinePendingStatic.test.ts for that half.
    expect(turn).toContain(
      '{status && !(isLastTurn && (inFlightSession || statusOwnedByPendingHead)) && ('
    );
    // 2026-09-19 (user decision) replaces F7b's 2026-09-10 ruling. The row
    // above the composer is GONE — `SessionActivityStatus` was deleted, not
    // just unmounted — because the turn progress head carries the clock and
    // the ↑↓ tokens next to the reply itself. What survives from F7b is the
    // no-duplicate rule, now in its only remaining direction: the timeline
    // must not resurrect the component to fill the gap.
    expect(SYNTAX, 'the retired composer status row must not come back').not.toContain(
      'SessionActivityStatus'
    );
    expect(turn).toContain('<TurnStatusContent status={status} />');
  });

  // 2026-09-10 local pass: between two assistant messages the last one already
  // carries a latency while the session still runs, so a collapse gated on that
  // latency alone hid the process mid-turn. 2026-09-18 keeps the same gate and
  // hands it to the work group as `settled`.
  it('the work group waits for the session, not only the last message', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    // 2026-09-18: `&& !statusOwnedByPendingHead` closes the handshake window in
    // which the session is in flight but the send's own turn has not been
    // echoed yet, so the PREVIOUS turn is still `isLastTurn`. Without it a
    // finished turn reverted to 「工作中」 and re-expanded every time the user
    // sent the next message.
    expect(turn).toContain(
      'const processSettled = !turnActive && !(isLastTurn && inFlightSession && !statusOwnedByPendingHead);'
    );
    // T113: this fact no longer reaches a head as `settled` — the head has no
    // settled state left. It reaches the turn's own row through `turnRunning`,
    // which is the same fact negated, and that is exactly what keeps the row
    // and `PendingTurnHead` a RELAY: the handshake window above is folded into
    // `processSettled`, so a turn that is not running cannot produce a ticking
    // shape (`deriveTurnWorkZone`, `[WZ-6]`).
    expectWired('const turnRunning = !processSettled;');
    expectCalled('running: turnRunning');
    expectUnwired('settled={processSettled}');
    // The per-segment fold this replaced. Its branch condition must not come
    // back: with one group per turn there is nothing left for a segment to
    // decide about its own visibility.
    expectUnwired('if (!answerable && processSettled) {');
    expectUnwired('<TurnProcessFold');
    expect(SYNTAX).not.toContain('durationMs={');
  });

  /**
   * The turn's duration is the TURN's — the whole of it, from the send.
   *
   * `formatWorkedForRow(metadata?.latencyMs)` is the shape this must not be: a
   * turn split by a tool result or an authorization wait is several messages,
   * and the final one's latency told a two-minute turn it took four seconds.
   * The `null` path matters just as much — a restored history turn replays no
   * timing events, and the head falls back to a step count rather than 0s.
   *
   * 2026-09-19 adds the half that was still missing. `deriveTurnWorkedMs`
   * measured from the first ASSISTANT message, so the wait before the first
   * byte — 7315ms of a measured 7936ms turn — was not in the number at all,
   * and the head reported 「已工作 1 秒」. The clock now runs from
   * `turnStartedAtMs`, and the SAME origin feeds the running head and the
   * finished one, which is what stops the count resetting at the first byte.
   */
  it('[WG-WIRE-1] the head reads the whole-turn span, from the send, and never fabricates one', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expectCalled('deriveTurnElapsedMs(');
    expect(turn).toContain('startedAtMs: turnStartedAtMs');
    expect(turn).toContain('running: turnRunning');
    // T113 changed only WHO reads the span: it reaches `deriveTurnWorkZone` as
    // a shorthand property now, not a group head's prop. The rule it is under
    // is unchanged — one whole-turn span, from the send.
    expect(turn).toContain('workedMs,');
    expectUnwired('workedMs={workedMs}');
    expectUnwired('formatWorkedForRow(');
    // The fallback is chosen inside the pure derivation, so the component must
    // not second-guess it with a `?? 0` on the way in.
    expectUnwired('workedMs={workedMs ?? 0}');
    expectCalled('deriveTurnWorkZone(');
    expectUnwired('deriveTurnWorkGroupLabel(');
  });

  /**
   * ONE origin per turn, and the order it is resolved in.
   *
   * The user message's own `message.started` has to come first: it is the only
   * candidate that outlives the send (the snapshot is torn down at the first
   * byte, the watch is cleared by the next send), so anchoring on anything else
   * means the origin moves mid-turn — which is the reset this batch removed.
   * The other two exist for the window before the Host echoes the prompt back,
   * where the turn on screen is the composer's optimistic bubble.
   */
  it('[WG-WIRE-1b] the turn origin prefers the durable stamp over the two live ones', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn).toContain(
      'const turnStartedAtMs = (turn.user ? (getMetadata(turn.user.id)?.startedAt ?? null) : null) ?? (inFlight && sendStatus ? sendStatus.turnStartedAtMs : null) ?? (pendingActive && pendingReply ? pendingReply.turnStartedAtMs : null);'
    );
    // Exactly one derivation of it: a second one elsewhere would be a fork of
    // the judgement this whole fix rests on.
    expect(SYNTAX.split('const turnStartedAtMs =').length - 1).toBe(1);
    // The snapshot's own commit stamp, NOT `elapsedSeconds` — that one is
    // phase-relative and is reset to 0 at dispatch, which is the second of the
    // two resets the field measurement caught.
    expect(turn).not.toContain('turnStartedAtMs = sendStatus.elapsedSeconds');
  });

  /**
   * ⚠️ [HEAD-CN-1] The turn progress head is CHINESE again, like the rest of
   * the chat surface (user decision 2026-09-22 — the chips redesign retired
   * the English exception that decision 031 D7 scoped to the old head).
   *
   * The regression this guards is the mirror of the old one: somebody
   * restoring `englishTranslate` because the binding "looks wrong" next to a
   * file-wide convention would silently put English chips on a Chinese
   * surface. No type error, no failing render, no other assertion.
   */
  it('[HEAD-CN-1] the head binds useI18n, and never englishTranslate', () => {
    const head = nodeSource(topLevelFunction('TurnProgressHead'));
    expect(head).toContain('const { t } = useI18n();');
    expect(head).not.toContain('englishTranslate');
    expect(SYNTAX).not.toContain("import { englishTranslate } from '@shared/i18n';");
    // The rest of the file is untouched: the status row and the retry banner
    // below the head are still localized, and still fed by the hook's `t`.
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn).toContain('const { t } = useI18n();');
  });

  /**
   * The head's keys are literal `t('…')` calls, not keys built from a
   * discriminant. `i18nCoverage.test.ts` can only scan literals, so a
   * `t(label.key)` would ship an untranslated head and no gate would notice.
   */
  it('[WG-WIRE-2] the head words itself from literal catalog keys', () => {
    const head = nodeSource(topLevelFunction('TurnProgressHead'));
    // Decision 034: the head words itself from the turn's CLOCK, through the
    // two helpers that own the four duration keys each. It prints no count of
    // its own — the step count and the call count were both cut by the user.
    expect(head).toContain('workingHeadText(t, zone.elapsed)');
    expect(head).toContain('workedHeadText(t, zone.worked)');
    for (const retired of [
      "'{{count}} steps processed'",
      "'{{count}} tool calls'",
      "t('Thinking chip')",
      "'{{count}} explanation'",
    ]) {
      expect(head, `the head no longer counts anything: ${retired}`).not.toContain(retired);
    }
  });

  /**
   * The 「授权详情」 disclosure is gone (user decision 2026-09-18), and the row
   * component that renders REFUSALS is not. Deleting both would have made a
   * denial silent, which is the opposite of what was asked for.
   */
  it('[WG-WIRE-3] the approval-details disclosure is gone; the refusal rows are not', () => {
    expectUnwired('PermissionActivityDetails');
    expectUnwired('activityDetails');
    expectCalled('<PermissionActivityRows');
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
   * ## The authorization red line — REWRITTEN 2026-09-18, and why
   *
   * This test used to read "the process segment renders unconditionally —
   * nothing can hide a permission card", and it asserted three negatives: no
   * `hidden={`, no conditional render of the process branch, no `<Collapsible`.
   * That phrasing was only available while the turn had NO collapsible shell
   * (2026-08-25 – 2026-09-10), and it had already gone stale once: the
   * per-segment `<details>` landed on 2026-09-10 and these negatives stayed
   * green throughout, because a `<details>` is none of the three things they
   * name. A structural "nothing can hide it" claim cannot survive the turn
   * having a collapse again — so it is replaced rather than patched.
   *
   * The guarantee is CONDITIONAL now and is asserted as a condition, in two
   * halves that have to hold together:
   *
   *  1. **the rule is reached** — `turnWorkGroupAwaitsUser` runs over the
   *     grouped segments and its answer arrives as `forcedOpen`, which
   *     `turnWorkGroupOpen` gives precedence over both the auto-collapse and
   *     the user's click (truth-tabled in `turnProcessFold.test.ts`);
   *  2. **the card is in the DOM either way** — the panel renders `{children}`
   *     unconditionally, so a collapsed group HIDES its content rather than
   *     unmounting it, and no state is lost when it reopens.
   *
   * Plus the one negative still worth keeping: the rule must exist in exactly
   * one place. A second copy of "is this card unanswered" inlined here would
   * eventually disagree with the module's, and the disagreement would show up
   * as a buried Allow/Deny card.
   */
  it('[FB6-4] an unanswered authorization pins the work group open, and its card never unmounts', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expectCalled('turnWorkGroupAwaitsUser(section.segments)');
    expectCalled('forcedOpen={groupForcedOpen}');
    // T105: `settled` left this call's arguments. It is still a prop of the
    // head (spinner, label, current-action clause) — it just no longer decides
    // whether the group is open. 2026-09-21 flipped that default from closed
    // to open; T107 restores closed process groups with prose outside. What did NOT
    // change is that this call takes three facts and no fourth, which is what
    // keeps "is this card unanswered" the only thing that can force it.
    expectCalled('turnWorkGroupOpen({ forcedOpen, userOpen })');

    const group = nodeSource(topLevelFunction('TurnProgressHead'));
    expect(group, 'the panel renders its children unconditionally').toContain(
      `<div className={cn(turnProcessShellClass(), 'pt-2')}>{children}</div>`
    );
    expect(group, 'the open bit must be the derived one, not a second rule').toContain(
      'const open = turnWorkGroupOpen({ forcedOpen, userOpen });'
    );
    // Base UI's panel carries `overflow-hidden` (COLLAPSIBLE_PANEL_BASE_CLASS),
    // which creates a containing block — the standing prohibition on the turn
    // chrome. The group is a native <details> for that reason.
    expect(group, 'no collapse component, and no overflow clip with it').not.toContain(
      '<Collapsible'
    );
    expect(turn, 'the predicate lives in turnProcessFold.ts, not inlined here').not.toContain(
      "item.kind === 'permission' || item.kind === 'question'"
    );
  });

  /**
   * S3 slice 4 (§3.2) INVERTED, 2026-09-18.
   *
   * It used to pin the decision→allow lambda IN THIS FILE, because the
   * answerable permission card rendered in block position here. The card moved
   * to `PendingPermissionDock`, and the whole point of the move is that there
   * is exactly ONE answerable copy on screen: a second one here would let the
   * same request be answered twice, from two places, with the later reply
   * landing on a gate that had already closed.
   *
   * So the assertion flips rather than disappearing. The positive half — the
   * lambda still exists, still derives `allow` from the decision, still
   * forwards the decision as the third argument — moved to
   * `pendingPermissionDock.test.ts`, where a real render can check it instead
   * of a source scan.
   */
  it('S3-4: no answerable permission card is left in the timeline', () => {
    // The response path in every spelling it has ever had here.
    expectUnwired('onRespondPermission');
    expectUnwired('canRespondPermission');
    expectUnwired('permissionDecisionAllows');
    expectUnwired("item.block.permissionId ?? '', allow)");
    // The settled copy DOES stay, in block position (T-05 D-5), and it stays
    // gated on `resolved` so an unanswered request cannot reappear here.
    expectWired('if (item.block.resolved !== true) return null;');
    expectWired('return <QuestionCard variant="permission" block={item.block} />;');
  });

  // F11: the panel needs its own gap or its rows sit flush at 0px while every
  // other pair inside the turn keeps P-17's 10px beat. 2026-09-18 adds the
  // ladder's dim rung to the same call — the panel is the one place that tone
  // applies, inside the group and in the streaming tail alike.
  it('F11: the process panel carries the process shell spacing and the dim tone', () => {
    expectCalled('cn(turnProcessShellClass(), turnBodyClass(), turnProcessToneClass())');
    // Answer text stays at the ordinary answer tone when it is final; only
    // grouped, intermediate prose uses the muted tone.
    expectWired('const tone = intermediate ? turnIntermediateToneClass() : turnAnswerToneClass();');
    expectCalled('cn(turnBodyClass(), tone)');
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
   * `F9: the footer reads an injected clock` retired with the meta row (T12-b),
   * and the reason it cannot come back is unchanged by T113/T114.
   *
   * F9 existed because the footer printed a RELATIVE age and nothing re-renders
   * an idle transcript, so every age froze at whatever it was when the last
   * token landed. The clock this app prints is ABSOLUTE (`HH:MM`), which stays
   * correct forever without a ticker — so F9's defect class cannot recur, and
   * this is what says the relative form did not sneak back in with its
   * stale-clock problem attached.
   *
   * REWRITTEN 2026-09-21 (T114): the assertion used to name the hover strip's
   * copy of that clock. T113 put a completion time on the always-visible work
   * zone row, so T114 removed the hover one — two printings of one timestamp on
   * one turn, one of them reachable only with a pointer. The claim therefore
   * splits in two: the absolute clock is still rendered, and it is NOT rendered
   * from the strip.
   */
  it('T114: the completion clock is absolute, and the hover strip no longer carries it', () => {
    expectCalled('formatAbsoluteTime(zone.completedAtMs)');
    expectUnwired('formatAbsoluteTime(metadata.completedAt)');
    for (const gone of ['useMinuteTick', 'footerNowMs', 'formatRelativeTimestamp']) {
      expect(SYNTAX, `the relative-age apparatus must not return: ${gone}`).not.toContain(gone);
    }
    // The strip is one control and no text. `showActions` was already gated on
    // the copy text alone, so a timestamp reappearing here would also be a row
    // that renders for a turn with nothing to copy.
    const body = nodeSource(turnBodyNode());
    const strip = body.slice(body.indexOf('turnActionsSlotClass()'));
    expect(strip).toContain('<TurnCopyButton text={actionsCopyText} />');
    expect(strip, 'no text node left beside the button').not.toContain('metadata');
    expect(strip).not.toContain('formatAbsoluteTime');
    expectWired('const showActions = actionsCopyText.length > 0;');
  });

  /**
   * T12 (replaces §5's band assertions). The bubble now renders through three
   * class functions and no wrapper: `userBubbleRowClass()` aligns it,
   * `userBubbleClass()` shapes it, `userBubbleTextClass()` sets the prose.
   *
   * The negatives are the load-bearing half, and T096 narrowed WHY they are.
   * `turnBubbleBandClass` was the `position: sticky` band and the two `fx-`
   * hooks were the `scroll-state()` query container that made the clamp
   * pinned-only. Those three are one apparatus and it is the apparatus that is
   * banned — a height that changes because the element got stuck, which closes
   * F10's loop (stuck -> shorter -> clamp -> unstuck).
   *
   * Pinning by itself is no longer the ban: T096 pins the thought fold header,
   * whose height is the same number stuck and unstuck. That element lives in
   * `ToolRows.tsx` and reaches its classes through
   * `chatTimelineLayout.thoughtFoldHeaderClass()`, so `MessageTimeline.tsx` is
   * still expected to carry no pinned element of its own — which is what the
   * bare-token assertion below now says, in place of "nothing anywhere pins".
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
    // T096: the one legal pin is the thought fold header, and it is not here.
    // Class tokens, not a substring scan — `stickToBottomRef` and `position` are
    // ordinary identifiers in this file and must not read as a pin.
    const pins = [...SYNTAX.matchAll(/["'`]([^"'`\n]*)["'`]/g)]
      .flatMap(([, body]) => body.split(/\s+/))
      .filter((token) => /(?:^|:)(?:sticky|fixed)$/.test(token));
    expect(pins, 'the timeline pins nothing of its own (T096: only ToolRows.tsx may)').toEqual([]);
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
      'className="text-chat-body leading-relaxed text-foreground whitespace-pre-wrap select-text"'
    );
    // The bubble's own prompt echo (`:845`) reads at the same rhythm but is a
    // different element with a different class order, so the count is of THIS
    // string — assistant prose that has not been parsed.
    // (T104 moved all of these from `text-markdown` to the runtime-configurable
    // `text-chat-body`; the DISTINCTIONS they draw are what is under test.)
    const proseClass =
      'text-chat-body leading-relaxed text-foreground whitespace-pre-wrap select-text';
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
    expectCalled('className="select-text whitespace-pre-wrap text-chat-body text-foreground"');
  });

  // The three surfaces T-29 deliberately does NOT touch. Each is model-adjacent
  // enough that "add markdown here too" is a plausible future edit, and each has
  // a reason not to: the user bubble is the operator's own prompt under an
  // unconditional line clamp (F10), a notice is an `Alert` body, and tool
  // IN/OUT is a mono transcript.
  it('T-29: user bubble and notice bodies stay plain text', () => {
    // Both paragraphs still exist and still pre-wrap. The class-string order is
    // what distinguishes them from `TurnItemView`'s streaming fallback, which
    // spells the same utilities in the opposite order (`text-chat-body` first).
    //
    // These used to be counted through their shared `whitespace-pre-wrap
    // text-markdown` prefix. D3-c inserted `break-words` into the user bubble's
    // string (§3.2's `min-width: auto` pair), so the prefix is no longer shared
    // and each paragraph is now pinned as a whole string — strictly stronger
    // than the prefix count it replaces, and it still fails if either is
    // deleted or routed into markdown.
    for (const cls of [
      'whitespace-pre-wrap break-words text-chat-body leading-relaxed text-foreground',
      'select-text whitespace-pre-wrap text-chat-body text-foreground',
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
    // The process branch keeps its own shell — spacing and tone only, no face,
    // no edge. (2026-09-18 added the third argument; the claim is unchanged.)
    expect(renderSegment).toContain(
      'cn(turnProcessShellClass(), turnBodyClass(), turnProcessToneClass())'
    );
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

  // Q1 keeps the final answer visible; earlier prose joins the process group.
  // Notices still render independently, and a tool-free turn has no empty fold.
  it('[WG-WIRE-4] the final answer stays outside and grouped prose uses the intermediate tone', () => {
    const body = nodeSource(turnBodyNode());
    expect(body).toContain('workSections.map((section) =>');
    expect(body).toContain(
      "if (section.kind !== 'processGroup') return renderSegment(section.segment);"
    );
    const finalAt = body.indexOf("if (section.kind === 'finalAnswer') {");
    const groupAt = body.indexOf("if (section.kind !== 'processGroup')");
    expect(finalAt).toBeGreaterThan(-1);
    expect(finalAt).toBeLessThan(groupAt);
    const finalBranch = body.slice(finalAt, groupAt);
    expect(finalBranch).toContain('{renderSegment(section.segment)}');
    expect(finalBranch).not.toContain('turnFinalAnswerClass');
    // Decision 033 D1: the extraction announces itself with a divider, and the
    // divider is the ONLY thing the final branch adds — no border, background
    // or container around the reply itself (D8 separates it by colour alone).
    expect(finalBranch).toContain('<div className={turnFinalAnswerDividerClass()}>');
    expect(finalBranch).toContain("t('Final output')");
    expect(countIn(body, 'turnFinalAnswerDividerClass()')).toBe(1);
    expect(body).toContain(
      'const renderGroupSegment = (segment: TurnSegment<TurnItem>) => renderSegment(segment, true);'
    );
    expect(body).toContain('{section.segments.map(renderGroupSegment)}');
    // T113 removed the `lastProcessSection === -1` head, which existed so a
    // turn with NO process at all still showed something for a 50-second wait.
    // `TurnWorkZoneRow` covers that turn along with every other one, from the
    // same clock — keeping both would put two progress lines on the turn whose
    // whole complaint was that it had none. `index` went with it: nothing in
    // this map cares which group is last any more.
    expect(body).not.toContain('lastProcessSection');
    expect(body).not.toContain('collapsible=');
    expect(body).not.toContain('workGroup.finalAnswer');
    const groupedHead = body.slice(
      body.indexOf('key={groupKey}'),
      body.indexOf('</TurnProgressHead>', body.indexOf('key={groupKey}'))
    );
    expect(groupedHead).not.toContain('renderSegment(section.segment)');
    expect(groupedHead).not.toContain('turnFinalAnswerClass()');
    expect(groupedHead).toContain('{section.segments.map(renderGroupSegment)}');
  });

  /**
   * T112 — a one-step group is rendered, not folded.
   *
   * The threshold is asserted to come from `turnProcessGroupFolds` rather than
   * from a comparison inlined here, because an inlined one is free to drift
   * from the count the head prints — and the visible symptom of that drift is a
   * disclosure whose summary reads 「1 个步骤」, which is the row it hides,
   * counted. The predicate itself is truth-tabled in `turnProcessFold.test.ts`.
   *
   * Position matters as much as presence: the early return has to precede the
   * head, or the group would render both. `indexOf` on the flattened body is
   * what says so.
   */
  it('[WG-WIRE-4b] a group with a single step renders in place, with no head and no chevron', () => {
    const body = nodeSource(turnBodyNode());
    expectCalled('turnProcessGroupFolds(groupedProcessItems)');
    expect(body).toContain('if (!turnProcessGroupFolds(groupedProcessItems)) {');
    expect(body).toContain(
      '<Fragment key={groupKey}>{section.segments.map(renderGroupSegment)}</Fragment>'
    );
    const branchAt = body.indexOf('if (!turnProcessGroupFolds(groupedProcessItems)) {');
    expect(branchAt, 'the branch exists').toBeGreaterThan(-1);
    expect(branchAt, 'and it returns before any head is built').toBeLessThan(
      body.indexOf('<TurnProgressHead key={groupKey}')
    );
    // The fold rule lives in one place: a second threshold spelled here would
    // be the fork this test exists to prevent.
    expect(countIn(body, 'countProcessSteps(')).toBe(0);
  });

  /**
   * The work zone row's numbers, and the one rule that governs all of them: a
   * figure nobody measured is omitted, never printed as zero.
   *
   * REWRITTEN 2026-09-21 (T113). This was `[WG-WIRE-5] the head reads live
   * tokens and thinking time` — the head does not read any of them now, and
   * two of the four it used to read are not on screen at all. What survives
   * unchanged is WHY each source is the one picked: every figure comes from
   * something already scoped to THIS turn (the usage registry attributes
   * `usage.updated` to the assistant message open at the time, the thinking
   * registry is keyed by block id, the call count is read off this turn's own
   * items), so there is no per-turn snapshot to arm and nothing to reset
   * between sends. Wiring any of them to a session-scoped source instead
   * (`sessionRuntimeFacts`'s `usage` is the tempting one; it holds the LAST
   * settled payload for the session) would paint the previous turn's numbers
   * onto the turn now running.
   */
  it('[WG-WIRE-5] the work zone row reads this turn own clock, calls and thinking time', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expectCalled('sumTurnThinkingMs(thinkingSpans, { nowMs, live: !processSettled })');
    expectCalled('countTurnToolCalls(items)');
    expect(turn).toContain('completedAtMs: metadata?.completedAt ?? null');
    expect(turn).toContain('thinkingMs: turnThinkingMs');
    // Token usage left the turn surface with the head. It is a CLOSED list of
    // four figures (user decision 2026-09-21), so this negative is the list
    // being closed — not an accident of refactoring.
    expectUnwired('sumTurnTokens(');
    expectUnwired('turnProgressClauses(');
    expectUnwired('tokens={');
    // 2026-09-19, unchanged by T113 except for the name: the seconds come from
    // the TURN clock, not from the composer's per-phase ticker.
    // `turnElapsedMs === null` is what says no clock exists (a session already
    // running when this window opened replays no origin); the old `?? 0`
    // fallback is what made a turn with no measurement print 「工作中 0 秒」.
    expect(turn).toContain(
      'const liveElapsedSeconds = turnRunning && turnElapsedMs !== null ? Math.floor(turnElapsedMs / 1000) : null;'
    );
    expectCalled('elapsedSeconds: liveElapsedSeconds');
    expectUnwired('elapsedSeconds={elapsedSeconds}');
    expectUnwired('headElapsedSeconds');
    // The session-scoped store is not a per-turn source. Named so the next
    // reader does not "simplify" the wiring into it.
    expect(SYNTAX).not.toContain('useSessionRuntimeFactsStore');
  });

  /**
   * The row exists, once, and it is pinned after the turn's last paragraph.
   *
   * Position is the task: the defect T113 fixed was a turn-level figure riding
   * whichever process group happened to be last, so it moved as the turn grew.
   * `[FB6-1]` already pins the trailing chrome (status, then the hover strip);
   * this pins the row between the content and that chrome, and that there is
   * exactly one of it.
   */
  it('[WG-WIRE-5b] the work zone row renders once, after the sections', () => {
    const body = nodeSource(turnBodyNode());
    expectCalled('zone={workZone}');
    expect(countIn(body, '<TurnWorkZoneRow')).toBe(1);
    expect(body.indexOf('<TurnWorkZoneRow')).toBeGreaterThan(body.indexOf('workSections.map'));
    expect(body.indexOf('<TurnWorkZoneRow')).toBeLessThan(body.indexOf('<RetryBanner'));
  });

  /**
   * The user's click outlives the element that took it.
   *
   * `TurnProgressHead` swaps between a `<details>` and a plain row as
   * `collapsible` flips, which a turn does the moment it makes its first tool
   * call. A `useState` inside the head would be discarded by that swap — so a
   * reader who expanded the group would watch it slam shut on the next tool
   * call, which is rule 2 of `turnWorkGroupOpen` failing silently.
   */
  it('[WG-WIRE-6] the expand choice is held by the turn, not by the head element', () => {
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    expect(turn).toContain(
      'const [workGroupUserOpen, setWorkGroupUserOpen] = useState<Record<string, boolean>>({});'
    );
    expectCalled('userOpen={workGroupUserOpen[groupKey] ?? null}');
    expectCalled('setWorkGroupUserOpen((previous) => ({ ...previous, [groupKey]: open }))');
    const head = nodeSource(topLevelFunction('TurnProgressHead'));
    expect(head, 'no second copy of the choice inside the element').not.toContain('useState');
  });

  /**
   * Decision 033 D1/D4 replaces Q1's three chips with two counts: the steps the
   * group folded, and how many of them were tool calls. T113's boundary is
   * unchanged — turn-level timing and usage never ride a process-group head.
   */
  it('[WG-WIRE-7] the head carries the turn clock, and exactly one head gets it', () => {
    const head = nodeSource(topLevelFunction('TurnProgressHead'));
    const turn = nodeSource(topLevelFunction('ChatTurn'));
    // Decision 034 moved the clock and the live action clause UP from the work
    // zone row. Both now belong here, and nothing counts anything.
    expect(countIn(head, 'deriveTurnCurrentAction(items)')).toBe(1);
    expect(head).toContain('<Spinner');
    for (const counter of [
      'countProcessSteps',
      'countTurnToolCalls',
      'chips.map(',
      'countProcessGroupThinking',
      'countProcessGroupExplanations',
    ]) {
      expect(head, `the head counts nothing: ${counter}`).not.toContain(counter);
    }
    // ⚠️ The T107 defect, as a wiring assertion: two groups in one turn must
    // not both print the turn's duration. The latch is what guarantees it, and
    // a refactor that drops it fails HERE rather than on screen.
    expect(turn).toContain('let zoneClaimed = false;');
    expect(turn).toContain('const headZone = zoneClaimed ? null : workZone;');
    expect(turn).toContain('zone={headZone}');
    // Every OTHER turn-level figure is still out of this element — the head
    // reports a clock, not a bill.
    for (const gone of [
      'workedMs',
      'elapsedSeconds',
      'tokens',
      'thinkingMs',
      'hasReplyContent',
      'collapsible',
      'turnProgressClauses',
    ]) {
      expect(head, `the group head must not carry ${gone}`).not.toContain(gone);
    }
  });

  /**
   * T105 (D6) — the live clause, and the three things about it that are easy
   * to get wrong without noticing. T113 moved it from the head to the work
   * zone row; all three still hold, against the row:
   *
   *  1. it is GATED on the turn running, or a finished turn keeps advertising
   *     what it was doing an hour ago;
   *  2. it is the LAST clause of a two-clause line — 「✻ 工作中 47 秒 · 读取中」
   *     — so the line reads as a clock first and a narration second;
   *  3. the settled line is the user's four figures in the user's order, with
   *     no fifth.
   *
   * Ordering is asserted by position in the joined line rather than by three
   * separate `expectCalled`s, because "all of them appear" is exactly the claim
   * that would stay green if they came out shuffled.
   */
  it('[WG-WIRE-8] the work zone row is settled-only, and lists three figures', () => {
    const row = nodeSource(topLevelFunction('TurnWorkZoneRow'));
    // Decision 034: the RUNNING state left this row for the process head, with
    // the clock and the live clause it was made of. A running turn renders
    // nothing here — two rows counting the same seconds is the defect.
    expect(row).toContain("if (zone.kind === 'working') return null;");
    expect(row).not.toContain('<Spinner');
    expect(row).not.toContain('deriveTurnCurrentAction');
    // The duration went up with them: printing 「已工作 N 秒」 in both places is
    // T107 restated.
    expect(row).not.toContain('workedHeadText');
    expect(row).not.toContain('workingHeadText');

    const completedAt = row.indexOf("t('Completed at {{time}}'");
    const calls = row.indexOf("'{{count}} tool calls'");
    const thinking = row.indexOf('formatThinkingClause(');
    expect(completedAt, 'the completion time is there').toBeGreaterThan(-1);
    expect(completedAt, 'and the call count follows it').toBeLessThan(calls);
    expect(calls, 'and the thinking time closes the line').toBeLessThan(thinking);
    // The closed list, as a negative: no token clause on this row, ever.
    expect(row).not.toContain('formatTurnTokenClauses');
    expect(row).not.toContain('tokens');
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
    // T067: `, t` is part of the token on purpose — the banner's copy comes
    // from the catalog now, and a pending head that forgot the translator
    // would print English under a Chinese composer again.
    // T093: the clock and the delegate name join that literal pair. `nowMs`
    // is what makes the countdown a countdown, and the pending head is the ONE
    // window where a subagent retry is most likely to be all there is on
    // screen — a head that forgot either would print a frozen number about an
    // unattributed request.
    expectCalled(
      '{ retry, inFlight: true, outputSinceRetry: false, nowMs, delegateName: retryDelegateName }'
    );
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
    // T093: the give-up button aborts a session by id, and the banner has no
    // other way to know which one — a required prop is what keeps the two
    // mounts from falling back to whatever is in the foreground (T091).
    expectWired(
      'function RetryBanner({ view, sessionId }: { view: RetryBannerView; sessionId: string })'
    );
    expectCalled('void stopChatSession(sessionId)');
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

/** Preserve prose and tool-row density independently of QuestionCard/extension
 * dialogs, whose multiline layout is covered by interaction/browser tests. */
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

  const DENSITY_CODE = CHAT_FILES.filter((file) =>
    [
      'MessageTimeline.tsx',
      'chatMarkdownPolicy.ts',
      'ToolRows.tsx',
      'chatTimelineLayout.ts',
    ].includes(path.basename(file))
  )
    .map((file) => stripComments(readFileSync(file, 'utf8'), file))
    .join('\n');

  it('exactly the three prose surfaces carry the 1.625 tier', () => {
    expect(
      countIn(DENSITY_CODE, 'leading-relaxed'),
      'root + user bubble + streaming fallback'
    ).toBe(3);
    // Spelled out so a failure names the surface, not just the count.
    expect(CHAT_CODE).toContain('break-words text-chat-body leading-relaxed text-foreground');
    expect(CHAT_CODE).toContain(
      'whitespace-pre-wrap break-words text-chat-body leading-relaxed text-foreground'
    );
    expect(CHAT_CODE).toContain(
      'text-chat-body leading-relaxed text-foreground whitespace-pre-wrap select-text'
    );
  });

  it('the tool rows, code block and turn skeleton retain the 1.5 tier', () => {
    expect(countIn(DENSITY_CODE, 'leading-normal')).toBe(3);
    expect(DENSITY_CODE).toContain('flex flex-col gap-2 text-chat-body leading-normal');
    expect(DENSITY_CODE).toContain('text-left text-chat-process leading-normal');
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
   * The button is positioned against the WRAPPER, not the scrollport, and both
   * halves of that still hold after T096 reopened `sticky` for one element.
   *
   * Inside the viewport an absolute child scrolls away with the content, which
   * is the original reason. The sticky alternative is now merely WRONG rather
   * than forbidden: the T096 rule is "a pinned element may not change its own
   * height with scroll state, and there is one of them" — this button would be
   * a second, and it would be pinned inside a stacking context (the viewport's
   * bottom-fade mask) that the header it competes with also lives in. Out here
   * it neither scrolls nor participates in the timeline's layout at all.
   */
  it('renders outside the scrollport and carries no sticky/fixed hook', () => {
    const anchorIndex = timeline.indexOf('showJumpToBottom && (');
    expect(anchorIndex).toBeGreaterThan(timeline.indexOf('</ScrollArea>'));
    const button = timeline.slice(anchorIndex);
    expect(button).toContain('absolute right-3 bottom-3');
    expect(button, 'the one legal pin is the thought fold header, not this').not.toMatch(
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
    const element = /<ToolGroup\b[^>]*>/.exec(toolGroupItem);
    expect(element?.[0]).toContain('sessionId={sessionId}');
  });
});
