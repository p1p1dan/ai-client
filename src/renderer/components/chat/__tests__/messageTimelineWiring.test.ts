import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
 * blanks them. Two of the four negatives (`max-w-[85%]`, `justify-end`) are
 * class names — string literals are precisely what they must forbid, and
 * blanking strings would make them vacuous, which is the failure mode F15
 * removed from the layout suite. Comments were the actual leak, and the AST
 * closes that exactly.
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
    const statementOnly = 'const collapsible = process.length > 0;';
    expect(SYNTAX).toContain(statementOnly);
    expect(CALL_SITES, 'a function body leaked into call position').not.toContain(statementOnly);
    // Negatives keep string literals, or class-name prohibitions mean nothing.
    expect(SYNTAX, 'string literals must survive for the negatives to bite').toContain(
      'rounded-br-xs'
    );
  });

  // F1: the head must come from the degradation chain, not from an inline
  // `status ? … : workedFor ? … : null` ternary.
  it('F1: the head is built by deriveTurnHeadModel', () => {
    expectCalled('deriveTurnHeadModel(');
    expectCalled('hasProcess: process.length > 0');
    // The trigger's existence is decided by the process segment alone — that is
    // what stops the Collapsible subtree from remounting when metadata lands.
    expectWired('const collapsible = process.length > 0;');
  });

  // §4.2: the counts riding inside the head are the compact rendering.
  it('the head counts use the compact stats style', () => {
    expectCalled("{ style: 'compact' }");
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

  // F5: without `keepMounted` the panel unmounts on collapse and every tool row
  // the user had expanded inside it is destroyed (§10-C).
  it('F5: the process panel is kept mounted across a collapse', () => {
    expectCalled('<CollapsibleContent');
    expectCalled('keepMounted');
  });

  // §4.3's safety red line: the shell is force-open while a permission is
  // unresolved, and its trigger is disabled so the state cannot be undone.
  it('the permission lock still forces the shell open and disables its trigger', () => {
    expectWired('permissionLock || processOpen');
    expectCalled('disabled={permissionLock}');
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

  // F10: releasing that lock must not collapse the shell under the cursor.
  it('F10: resolving a permission re-opens the shell instead of dropping it', () => {
    expectWired('if (wasPermissionLockedRef.current && !permissionLock) setProcessOpen(true);');
  });

  // F11: the shell root needs its own gap or the trigger and the panel sit
  // flush at 0px.
  it('F11: the collapsible root carries the process shell spacing', () => {
    expectCalled('className={turnProcessShellClass()}');
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

  // F13: a half-streamed answer must not be silently copyable.
  it('F13: copy is withheld while the turn is in flight', () => {
    expectCalled("copyText={turnActive ? '' : copyText}");
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

  // F9: the footer's relative age must advance on its own clock.
  it('F9: the footer reads an injected clock, not Date.now() at render time', () => {
    expectCalled('useMinuteTick()');
    expectCalled('formatTime: (ms) => formatRelativeTimestamp(ms, nowMs)');
  });

  // §5 (F10 as-built): the band renders through its class function alone and
  // the bubble text through `userBubbleTextClass()` — the unconditional-clamp
  // fallback (§5.6-B). The scroll-state container hooks are GONE by design:
  // the pinned-only clamp coupled scroll position to layout height and
  // oscillated. The negatives keep either hook from quietly coming back.
  it('§5: the sticky band and the clamped bubble use their class functions', () => {
    expectCalled('turnBubbleBandClass()');
    expectCalled('userBubbleTextClass()');
    expect(SYNTAX, 'fx-turn-band must not return (F10)').not.toContain('fx-turn-band');
    expect(SYNTAX, 'fx-turn-bubble-text must not return (F10)').not.toContain(
      'fx-turn-bubble-text'
    );
  });

  // The panel's opt-out of Base UI's measured-height mechanism (see
  // `chatTimelineLayout.turnProcessPanelClass`) is only in effect if the class
  // is actually applied to the panel.
  it('the process panel keeps its measured-height opt-out', () => {
    expectCalled('cn(turnProcessPanelClass(), turnBodyClass())');
  });

  // T-29: assistant prose is Markdown, and it is Markdown in exactly ONE place.
  //
  // This test is the reason the render point could be identified at all: the
  // task brief pointed at `:686`/`:711` as the assistant text sites, and both
  // turned out to be something else (the user bubble's prompt echo and
  // `NoticeMessage`'s alert body). The real one is `TurnItemView`'s `text`
  // branch, which serves BOTH turn segments. These assertions pin that, so a
  // future edit that "helpfully" markdowns the other two fails here.
  it('T-29: the text branch is gated by shouldRenderMarkdown and renders ChatMarkdown', () => {
    // The gate reads the streaming-block id the timeline already derives — not
    // a new store field (`chatSessions.ts` is a red line) and not a shape test.
    expectCalled('shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })');
    expectCalled('<ChatMarkdown');
    // Exactly one markdown render site in the whole file. This is the assertion
    // that keeps the user bubble, the notices and the tool rows out of it.
    expect(
      (CALL_SITES.match(/<ChatMarkdown/g) ?? []).length,
      'assistant prose must have exactly ONE markdown render site'
    ).toBe(1);
    // The streaming branch is still the plain-text paragraph, unchanged.
    expectWired("const text = item.block.text ?? '';");
    expectCalled(
      'className="text-markdown leading-normal text-foreground whitespace-pre-wrap select-text"'
    );
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
    // spells the same utilities in the opposite order.
    expect(
      (SYNTAX.match(/whitespace-pre-wrap text-markdown/g) ?? []).length,
      'the user bubble and NoticeMessage paragraphs must both survive verbatim'
    ).toBe(2);
  });

  // F13's sibling: the copy payload is the RAW markdown source, so the button
  // keeps yielding what the model wrote rather than the rendered text. T-29
  // changes nothing here, and this assertion is what says so.
  it('T-29: copy still ships the raw markdown source', () => {
    expectCalled('buildTurnCopyTextFromItems(items)');
  });

  // D26 ④: the user bubble spans the reading column. Both tokens are named in
  // the comment that explains their removal, so these only mean anything with
  // comments blanked — and both are class-name STRINGS, which is why the
  // negative projection keeps string literals.
  it('D26 ④: the user bubble is full width', () => {
    expectUnwired('max-w-[85%]');
    expectUnwired('justify-end');
    // …but the FOOTER's own right alignment is a different element and stays.
    expectCalled('turnFooterClass()');
  });

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

  // D33 (streaming build spec, slice 3): the live output-token estimate must
  // follow the exact same last-turn-only discipline as `nowMs`/`retry` (F7) —
  // a narrow primitive selector at the parent, gated to `null` for every turn
  // but the last, and the `✽` glyph applied at exactly one `.tsx` render site
  // (never inside the pure `turnStatus.ts` module, per that file's own
  // copy/decoration split).
  it('D33: the live token estimate is scoped like nowMs/retry, and the ✽ glyph is a .tsx-only decoration', () => {
    // A narrow primitive selector — never the whole per-session facts object.
    expectCalled('useSessionRuntimeFactsStore(');
    expectWired('state.factsBySession[sessionId]?.turnTokensDisplay ?? null');
    // Last-turn-only gate on the prop passed down to ChatTurn — the same
    // discipline as `nowMs={isLastTurn ? nowMs : STATIC_NOW_MS}` above.
    expectCalled('outputTokensDisplay={isLastTurn ? outputTokensDisplay : null}');
    // Reaches the pure status derivation.
    expectCalled('outputTokensDisplay,');
    // The glyph is added at render time, gated on kind, never inside
    // `deriveTurnStatus`'s own text (that stays store/glyph-free by spec).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning literal source text, not writing a template string
    expectWired("status.kind === 'streaming' ? `✽ ${status.text}` : status.text");
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
