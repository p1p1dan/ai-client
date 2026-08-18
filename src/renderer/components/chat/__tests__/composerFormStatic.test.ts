import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * T-30b2 F-A20 (absorbs the earlier F-A8): static evidence that the merged
 * model control actually replaced the two `Select`-based ones, rather than
 * being added beside them.
 *
 * This is a filesystem scan rather than a class assertion because what it
 * guards is a DELETION. A future edit can reintroduce `SelectTrigger` into
 * this directory without touching any pure function, and no other assertion in
 * this suite would notice.
 */

const CHAT_DIR = join(process.cwd(), 'src/renderer/components/chat');

/**
 * Scans below read CODE, not prose. Both banned names are quoted at length in
 * the doc comments that record WHY they were removed — a scanner that cannot
 * tell the two apart would force the codebase to choose between keeping the
 * scan and keeping the explanation, and the explanation is the only thing
 * stopping the next person from reintroducing them.
 *
 * The strip is the shared, parser-backed one (see `./stripComments`). The
 * regex pair that used to live here — including its `[^:]` guard, which only
 * ever protected the `https://` shape where the colon is immediately in front —
 * deleted real code out of this very directory: `EnhancedInput.tsx`'s
 * `accept="image/*"` paired with the next block-comment terminator and took the
 * JSX between them with it. Deleted code cannot contain `SelectTrigger`, so the
 * scans below were partly asserting over text that is not in the file.
 */
function readStripped(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('F-A20: composer form static scan', () => {
  it('the two superseded selector components are gone', () => {
    const names = readdirSync(CHAT_DIR);
    expect(names).not.toContain('ModelSelect.tsx');
    expect(names).not.toContain('EffortSelect.tsx');
  });

  // `SelectTrigger` is an INPUT-CONTROL primitive: it brings a border, a
  // shadow, an inner highlight and a width floor, and its radius token clamps
  // to a full pill at this control height. That package is right for a form
  // page and wrong for a toolbar dropdown — the whole "too round / too AI"
  // reading traced back to two of them sitting in the composer bar. Toolbar
  // dropdowns here use the ghost-chip form instead.
  it('no SelectTrigger survives anywhere under components/chat', () => {
    const offenders = collectFiles(CHAT_DIR).filter(
      (file) => !file.includes('__tests__') && /\bSelectTrigger\b/.test(readStripped(file))
    );
    expect(offenders).toEqual([]);
  });

  // The two deleted components carried `min-w-22` (88px) and `min-w-26`
  // (104px) floors sized to their own longest labels. Combined with
  // `justify-between`, a short label sat in the left part of an over-wide pill
  // with dead space before the chevron — which was reported as "the text is
  // not centred". The real defect was a width floor wider than the content, so
  // the fix is content-fit width, and a floor coming back would revive the
  // same misread.
  it('no fixed width floor comes back to the composer controls', () => {
    const offenders = collectFiles(CHAT_DIR).filter((file) => {
      if (file.includes('__tests__')) return false;
      return /\bmin-w-2[26]\b/.test(readStripped(file));
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * F6 (2026-08-18) — JSX AST locators for the composer card's two-row session
 * layout.
 *
 * Why the toolkit above is not enough: everything before this point is a
 * DIRECTORY SCAN over de-commented text. That posture can prove a name is
 * absent, and nothing else. The three facts F6 has to hold are all
 * STRUCTURAL — which element is whose direct child, in what order, and in
 * which branch of the mode ternary — and every one of them is invisible to a
 * whole-file `toContain` check:
 *
 *  - "the textarea no longer shares a row with the controls" is a sibling
 *    fact; both spellings contain the same identifiers.
 *  - "the session control row ends with the action group" is a presence AND
 *    position fact; `composerActionGroupClass()` has been in this file since
 *    T-30b2 — in the EMPTY branch. A file-level presence check passes while
 *    the session row omits it entirely.
 *  - "the empty branch's reading order did not get 'unified' along the way"
 *    (T-30b2 §5.2) is an order fact over six siblings.
 *
 * So the source is parsed with the TypeScript compiler API and the assertions
 * walk real nodes. Comments are NOT stripped here: the parser already knows
 * which spans are trivia, which is the same reason `stripComments` exists.
 */

const COMPOSER_PATH = join(CHAT_DIR, 'ChatComposer.tsx');

function parseTsx(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

const composerAst = parseTsx(COMPOSER_PATH);

/** Collapses formatting so a multi-line expression compares as written prose. */
function normalise(node: ts.Node): string {
  return node.getText(composerAst).replace(/\s+/g, ' ').trim();
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * The one `mode === 'session' ? … : …` ternary in the composer's JSX.
 *
 * Uniqueness is asserted rather than assumed: the file also holds two
 * `mode === 'session' && …` guards (the queue strip and the target bar), and
 * those are binary expressions, not conditionals. If a second ternary on the
 * same condition ever appears, silently taking the first one would let every
 * assertion below point at the wrong branch — so that case throws instead.
 */
function sessionModeTernary(): ts.ConditionalExpression {
  const matches: ts.ConditionalExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && normalise(node.condition) === "mode === 'session'") {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(composerAst);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one \`mode === 'session'\` ternary, found ${matches.length}`);
  }
  return matches[0];
}

type JsxHost = ts.JsxElement | ts.JsxFragment;

function asJsxHost(node: ts.Node): JsxHost {
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return node;
  throw new Error(`expected a JSX element or fragment, got ${ts.SyntaxKind[node.kind]}`);
}

/** JSX children that render something: whitespace and `{/* … *\/}` dropped. */
function meaningfulChildren(host: JsxHost): ts.JsxChild[] {
  return host.children.filter((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    if (ts.isJsxExpression(child)) return child.expression !== undefined;
    return true;
  });
}

/** `{cond && <…/>}` — the conditional-render shape, excluded from row counts. */
function isConditionalRender(child: ts.JsxChild): boolean {
  return (
    ts.isJsxExpression(child) &&
    child.expression !== undefined &&
    ts.isBinaryExpression(child.expression) &&
    child.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

function classNameOf(node: ts.JsxChild | ts.Node): string | null {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null;
  if (!opening) return null;
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(composerAst) !== 'className') continue;
    const init = attr.initializer;
    if (init && ts.isJsxExpression(init) && init.expression) return normalise(init.expression);
    if (init && ts.isStringLiteral(init)) return init.text;
  }
  return null;
}

/**
 * A stable name for one slot in a row, so ORDER can be compared as data.
 *
 * `{attachButton}` reads as its identifier, `{renderStatusLine(…)}` as its
 * callee, and a real element as its `className` expression. Anything else
 * returns its raw text, which fails the comparison loudly rather than
 * collapsing two different slots onto one label.
 */
function slotToken(child: ts.JsxChild): string {
  if (ts.isJsxExpression(child) && child.expression) {
    const expr = child.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  }
  const className = classNameOf(child);
  if (className !== null) return className;
  return normalise(child);
}

function references(node: ts.Node, name: string): boolean {
  let hit = false;
  const visit = (current: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(current) && current.text === name) {
      hit = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return hit;
}

describe('F6: the session composer card is two rows, the empty card is unchanged', () => {
  // [F6-4] The half-done landing this catches: wrapping the existing seven-item
  // row in a new flex-col and calling it done. Every identifier stays put, the
  // class-assembly assertions in `middleColumnLayout.test.ts` all still pass,
  // and the card looks two-row-ish only because the extras stack is above it.
  // The fact that separates the real change from that one is arity — the
  // column holds exactly two rows, and the textarea is alone in the first.
  it('[F6-4] the session branch is a two-row column with the textarea alone in row 1', () => {
    const rows = asJsxHost(unwrapParens(sessionModeTernary().whenTrue));
    expect(classNameOf(rows)).toBe('composerRowsClass()');

    const children = meaningfulChildren(rows).filter((child) => !isConditionalRender(child));
    expect(children.map(slotToken)).toEqual(['textareaEl', "composerBarClass('session')"]);

    expect(references(children[0], 'textareaEl')).toBe(true);
    expect(references(children[1], 'textareaEl')).toBe(false);
  });

  // [F6-5] `composerActionGroupClass()` predates this change and lives in the
  // empty branch, so a whole-file presence check is guaranteed to pass whether
  // or not the session row ever picks it up — the assertion has to be scoped to
  // the row located above. Order matters as much as presence: the group's whole
  // job is `ms-auto` tail-anchoring, which only reads correctly as the last
  // child. Row 2's own left-to-right order is pinned in the same breath (D48 S1
  // §3.2: agent before model, because which models exist follows from which
  // agent runs the chat).
  it('[F6-5] session row 2 reads attach → agent → model → permission → actions, tail-anchored', () => {
    const rows = asJsxHost(unwrapParens(sessionModeTernary().whenTrue));
    const controlRow = meaningfulChildren(rows)
      .filter((child) => !isConditionalRender(child))
      .find((child) => classNameOf(child) === "composerBarClass('session')");
    expect(controlRow).toBeDefined();

    const slots = meaningfulChildren(asJsxHost(controlRow as ts.JsxChild)).map(slotToken);
    expect(slots).toEqual([
      'attachButton',
      'agentPicker',
      'modelEffortControls',
      'permissionControl',
      'composerActionGroupClass()',
    ]);
    expect(slots[slots.length - 1]).toBe('composerActionGroupClass()');
  });

  // [F6-6] T-30b2 §5.2's reading order has no other static guard. The empty
  // card was already two rows before F6, so the cheapest way to "finish" this
  // change is to unify the two branches — which would silently reorder the
  // empty card's bottom bar and move its status line into an extras stack it
  // does not have. These are ORDER comparisons, not set comparisons, for
  // exactly that reason.
  it('[F6-6] the empty branch keeps its T-30b2 §5.2 order, untouched by the session split', () => {
    const empty = asJsxHost(unwrapParens(sessionModeTernary().whenFalse));
    const children = meaningfulChildren(empty);
    expect(children.map(slotToken)).toEqual([
      'textareaEl',
      'noticeBlock',
      'queueNoticeBlock',
      'attachmentChipsBlock',
      'mentionChipsBlock',
      "composerBarClass('empty')",
    ]);

    const bottomBar = children.find((child) => classNameOf(child) === "composerBarClass('empty')");
    expect(bottomBar).toBeDefined();
    expect(meaningfulChildren(asJsxHost(bottomBar as ts.JsxChild)).map(slotToken)).toEqual([
      'attachButton',
      'agentPicker',
      'modelEffortControls',
      'permissionControl',
      'renderStatusLine',
      'composerActionGroupClass()',
    ]);
  });

  // The session status line moved into the extras stack (§6.4): it is a
  // draft-side attachment-I/O fact, same family as the notice and the chips,
  // and its old row no longer has an elastic text slot to lend it. The stack's
  // render gate has to widen with it — left at `hasComposerExtras` alone, the
  // reading spinner and the large-attachment hint would render into a
  // container that never mounts, i.e. disappear.
  it('[F6-4] the session status line renders inside the extras stack, on a widened gate', () => {
    const rows = asJsxHost(unwrapParens(sessionModeTernary().whenTrue));
    const extras = meaningfulChildren(rows).filter(isConditionalRender);
    expect(extras).toHaveLength(1);

    const gate = (extras[0] as ts.JsxExpression).expression as ts.BinaryExpression;
    expect(normalise(unwrapParens(gate.left))).toBe('hasComposerExtras || statusRowVisible');

    const stack = asJsxHost(unwrapParens(gate.right));
    expect(meaningfulChildren(stack).map(slotToken)).toEqual([
      'noticeBlock',
      'queueNoticeBlock',
      'attachmentChipsBlock',
      'mentionChipsBlock',
      'renderStatusLine',
    ]);
  });
});
