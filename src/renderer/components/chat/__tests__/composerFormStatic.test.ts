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

/**
 * The one JSX element whose `className` expression reads exactly `className`.
 *
 * Uniqueness is asserted rather than assumed: silently taking the first match
 * would let every assertion below point at the wrong element.
 */
function elementByClass(className: string): ts.JsxElement {
  const matches: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && classNameOf(node) === className) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(composerAst);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one element with className ${className}, found ${matches.length}`
    );
  }
  return matches[0];
}

/** The value expression of a JSX attribute on a self-closing element, normalised. */
function attributeOf(node: ts.JsxSelfClosingElement, name: string): string | null {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(composerAst) !== name) continue;
    const init = attr.initializer;
    if (init && ts.isJsxExpression(init) && init.expression) return normalise(init.expression);
  }
  return null;
}

// PiLab R2: the card also lights up while a file is dragged over it.
const CARD_CLASS = "cn(composerCardClass(mode, { hasProtrusion }), fileDragOver && 'drop-target')";

describe('the composer box is one thin input row, its other controls in the row below', () => {
  // 2026-10-22 (user ruling, Claude Code desktop look): inside the frame there
  // is only the draft extras stack (conditional) and ONE input row. Anything
  // else rendering unconditionally in the card is a control that should have
  // moved to the row below.
  it('the card holds the input row and nothing else unconditional, in both modes', () => {
    const card = elementByClass(CARD_CLASS);
    const children = meaningfulChildren(card).filter((child) => !isConditionalRender(child));
    expect(children.map(slotToken)).toEqual(['composerInputRowClass()']);
  });

  // The textarea shares its row with ⊕ and the action key, in that order, and
  // each end is wired to the RIGHT array — `renderBarSlots` alone reads
  // identically whichever array is passed.
  it('the input row is ⊕, the textarea slot, then the tail-anchored action group', () => {
    const row = elementByClass('composerInputRowClass()');
    const children = meaningfulChildren(row);
    expect(children.map(slotToken)).toEqual([
      'renderBarSlots',
      'composerTextareaSlotClass()',
      'composerActionGroupClass()',
    ]);
    expect(normalise(children[0])).toContain('COMPOSER_CARD_LEADING');
    expect(references(children[1], 'textareaEl')).toBe(true);
    expect(normalise(children[2])).toContain('COMPOSER_CARD_TRAILING');
    // The action group must stay last, or `ms-auto` anchors nothing.
    expect(references(children[0], 'textareaEl')).toBe(false);
    expect(references(children[2], 'textareaEl')).toBe(false);
  });

  // The status line is a draft-side fact and renders in the extras stack above
  // the input row. Its gate has to widen with it — left at `hasComposerExtras`
  // alone, the reading spinner and the large-attachment hint would render into
  // a container that never mounts, i.e. disappear.
  it('the extras stack sits above the input row, on a widened gate, in a fixed order', () => {
    const card = elementByClass(CARD_CLASS);
    const children = meaningfulChildren(card);
    const extras = children.filter(
      (child) =>
        isConditionalRender(child) &&
        references(child, 'hasComposerExtras') &&
        !references(child, 'slashOpen') &&
        !references(child, 'mentionOpen')
    );
    expect(extras).toHaveLength(1);
    const inputRowAt = children.findIndex(
      (child) => classNameOf(child) === 'composerInputRowClass()'
    );
    expect(children.indexOf(extras[0])).toBeLessThan(inputRowAt);

    const gate = (extras[0] as ts.JsxExpression).expression as ts.BinaryExpression;
    expect(normalise(unwrapParens(gate.left))).toBe('hasComposerExtras || statusRowVisible');

    const stack = asJsxHost(unwrapParens(gate.right));
    expect(classNameOf(stack)).toBe('composerExtrasClass()');
    expect(meaningfulChildren(stack).map(slotToken)).toEqual([
      'noticeBlock',
      'queueNoticeBlock',
      // PiLab R2: "no such command", with Send anyway.
      'unknownCommandBlock',
      'attachmentChipsBlock',
      // T3: the "model will not see this image" warning sits under the chips.
      'imageInputHintBlock',
      'mentionChipsBlock',
      'renderStatusLine',
    ]);
  });

  // The start screen's bare row under the box: permission on the left, the
  // trailing group (model/effort, context use) anchored right.
  it('the start-screen row below maps the bar slots, the trailing group last', () => {
    const bar = elementByClass('composerBarClass()');
    const children = meaningfulChildren(bar);
    expect(children.map(slotToken)).toEqual(['renderBarSlots', 'composerBarTrailingClass()']);
    expect(normalise(children[0])).toContain('COMPOSER_BAR_LEADING');
    expect(normalise(children[1])).toContain('COMPOSER_BAR_TRAILING');
  });

  // In a conversation and on the home page the row below IS the target row,
  // which takes the same two arrays at its two ends.
  it('the session row below is the target bar, handed the bar slots at its two ends', () => {
    const bars: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(composerAst) === 'ComposerTargetBar'
      ) {
        bars.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(composerAst);
    const withSlots = bars.filter((bar) => attributeOf(bar, 'leading') !== null);
    expect(withSlots).toHaveLength(1);
    expect(attributeOf(withSlots[0], 'mode')).toBe('mode');
    expect(attributeOf(withSlots[0], 'leading')).toBe('renderBarSlots(COMPOSER_BAR_LEADING)');
    expect(attributeOf(withSlots[0], 'trailing')).toBe('renderBarSlots(COMPOSER_BAR_TRAILING)');
  });
});

/**
 * U12 — the `permission` bar slot is no longer null.
 *
 * The slot was reserved in U09-2 as `permission: null`. U12 fills it with
 * `ComposerPermissionTrigger`. A static scan catches the regression where
 * someone reverts the slot back to `null` — that is not a component-render
 * fact, just a spelling fact in the source.
 */
describe('U12: permission bar slot is wired', () => {
  it('the barSlotNodes record assigns a non-null value to the permission slot', () => {
    const source = readStripped(join(CHAT_DIR, 'ChatComposer.tsx'));
    expect(source).toContain('ComposerPermissionTrigger');
    expect(source).not.toMatch(/permission\s*:\s*null/);
  });

  /**
   * Mode-lock regression pin: the slot used to feed `ComposerPermissionTrigger`
   * bare `sending` — ChatComposer's own send latch, true only for the brief
   * window a send request is in flight. By the time an approval card is on
   * screen the turn is well past that window (`sending` has already fallen
   * back to false), so the trigger's mode lock almost never saw a true value
   * again. `busy` (`isStoppable(activeSession?.status)`) is what stays true for
   * the whole turn — the same union `canStop` already uses — so the slot must
   * feed that union, not the latch alone. A render-level assertion cannot
   * reach this fact because no test in this suite mounts `ChatComposer` itself;
   * see `composerPermissions.test.ts` for the receiving prop's own lock
   * behaviour once it is true.
   *
   * T091: the latch is per-session now (`sendingHere`), which narrows the union
   * further in exactly the right direction — a turn belonging to a DIFFERENT
   * session must not lock this session's permission tier either. The rule the
   * pin protects is unchanged: `busy` must still be in the union, because it is
   * the half that stays true for the whole turn.
   */
  it('feeds the permission slot the busy || sending union, not the latch alone', () => {
    const source = readStripped(join(CHAT_DIR, 'ChatComposer.tsx'));
    expect(source).toContain('turnActive={busy || sendingHere}');
    expect(source).not.toContain('turnActive={sending}');
    expect(source).not.toContain('turnActive={sendingHere}');
  });
});

/**
 * F456 slice ④ §7.4 / §8.4 `[F4-7]` — the `↑` count is a COMMIT-POINT
 * snapshot, counted in code points.
 *
 * Two facts, both invisible to any other assertion in this repo:
 *
 *  - the source is `committed`, not the live `value`. The textarea is not
 *    cleared until after the send resolves, and the user can start typing the
 *    next message while this one is in flight — a live read would show the
 *    in-flight turn a character count belonging to a message it never sent.
 *    Exactly the reason `attachmentCount`/`attachmentBytes` next to it take
 *    `drafts` rather than live state, stated word for word at the same site.
 *  - the count is `[...text].length`, i.e. CODE POINTS. `.length` counts UTF-16
 *    units, so an emoji would be reported as two characters. The opposite call
 *    to `CHAT_HIGHLIGHT_MAX_CHARS`'s deliberate use of units is not a
 *    contradiction: that one measures tokeniser cost, this one answers "how
 *    much did I type".
 */
describe('[F4-7] the ↑ prompt count is taken at the commit point', () => {
  it('[F4-7] beginTurnSend receives promptChars counted in code points off `committed`', () => {
    const source = readStripped(join(CHAT_DIR, 'ChatComposer.tsx'));
    const call = source.match(/beginTurnSend\(\s*\{[^}]*\}/);
    expect(call, 'beginTurnSend call not found').not.toBeNull();
    const args = call?.[0] ?? '';
    expect(args).toContain('promptChars');
    expect(args).toContain('[...committed.text].length');
    // A live read is the defect this guards; naming it here is what makes the
    // assertion point at a specific regression rather than a style.
    expect(args).not.toContain('promptChars: value');
    expect(args).not.toContain('promptChars: text.length');
  });
});
