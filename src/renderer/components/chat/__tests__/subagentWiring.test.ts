import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * T-34 wiring smoke — BRITTLE BY DESIGN, same charter and limits as
 * `messageTimelineWiring.test.ts` (see its header for the full argument):
 * node-env vitest cannot render `.tsx`, so this asserts PRESENCE of the
 * wiring tokens in call/JSX-attribute position, parsed via the TypeScript
 * AST (never raw text) so comments cannot satisfy an assertion. It is not a
 * reachability or correctness proof; the value/derivation layer is truth-
 * tabled in `subagentActivityModel.test.ts`.
 *
 * Guarded wirings:
 *  - ToolRows.tsx mounts `SubagentActivity` behind the `isDelegationTool`
 *    gate, keyed by the row's own `toolCallId`, and the Collapsible open
 *    default is `view.defaultOpen ?? view.failed`.
 *  - ChatWorkspace.tsx owns the store's `init()` latch (app-lifetime mount).
 *  - QuestionCard.tsx derives the permission-origin chip from the store.
 *  - RED LINE: `chatSessions.ts` remains untouched by T-34 — its source
 *    must not mention subagent lanes at all.
 */

function load(relative: string, kind: ts.ScriptKind) {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);

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

describe('ToolRows.tsx — subagent panel mount', () => {
  const { callSites, syntax } = load('../ToolRows.tsx', ts.ScriptKind.TSX);

  it('mounts SubagentActivity behind the isDelegationTool gate, keyed by the row toolCallId', () => {
    expect(syntax).toContain('isDelegationTool(view.toolName)');
    expect(callSites).toContain('SubagentActivity');
    expect(callSites).toContain('parentToolCallId={view.toolCallId}');
    expect(callSites).toContain('parentRunning={view.running}');
  });

  it('subscribes only inside the panel component and derives rows from the lane', () => {
    expect(
      callSites.some((site) => site.startsWith('useSubagentActivityStore((s) => s.lanes['))
    ).toBe(true);
    expect(callSites.some((site) => site.includes('deriveSubagentPanelRows(lane'))).toBe(true);
  });

  /**
   * T-34's `defaultOpen` opens a row at mount when nothing else has an opinion
   * — the live subagent panel sets it. What changed (2026-08-25, user decision)
   * is the fallback: failures used to auto-expand (sign-off ②), and with the
   * turn-level collapse retired that put a wall of output on screen for every
   * failed or denied call. Red on the row and a click is enough.
   *
   * T12-d moved the expression, not the rule. The decision is now
   * `resolveToolRowOpen`, whose LAST rule is `defaultOpen ?? false` — the same
   * answer this assertion used to read literally — with a remembered user
   * choice ahead of it. The negatives are unchanged and still load-bearing:
   * `view.failed` must not re-enter the mount decision by any route.
   */
  it('the Collapsible default is the resolved open state, seeded once at mount', () => {
    expect(callSites).toContain('defaultOpen={initialOpen}');
    expect(
      callSites.some((site) =>
        site.includes('resolveToolRowOpen(view, readToolExpandMemory(sessionId))')
      ),
      'the seed must come from the resolver, not from a second copy of its rules'
    ).toBe(true);
    // Neither the pre-T-34 failed-only literal nor the retired failed fallback
    // may come back: either would ignore the panel's live-open rule, or
    // re-open every failure.
    expect(callSites).not.toContain('defaultOpen={view.failed}');
    expect(callSites).not.toContain('defaultOpen={view.defaultOpen ?? view.failed}');
    expect(
      callSites.some((site) => site.startsWith('defaultOpen=') && site.includes('failed')),
      'no failed-driven expression may reach the mount decision'
    ).toBe(false);
  });

  /**
   * T12-d: the memory is WRITE-THROUGH on the user's own toggle and read only
   * at mount. A `open={...}` prop here instead would be the regression this
   * design exists to avoid: T-34's `defaultOpen: true` disappears the moment
   * the subagent lane stops being live, so a controlled binding would slam the
   * panel shut under a reader mid-sentence.
   */
  it('records the user toggle and never binds the row as controlled', () => {
    expect(
      callSites.some((site) => site.includes('setToolRowExpanded(sessionId, view.key, open)')),
      'the toggle must be written to the session memory'
    ).toBe(true);
    expect(
      callSites.some((site) => /^open=\{/.test(site)),
      'a controlled `open` would re-close the live subagent panel when it settles'
    ).toBe(false);
  });
});

describe('ChatWorkspace.tsx — store lifecycle ownership', () => {
  const { callSites } = load('../ChatWorkspace.tsx', ts.ScriptKind.TSX);

  it('owns the subagent store init latch', () => {
    expect(callSites).toContain('useSubagentActivityStore.getState().init()');
  });
});

describe('QuestionCard.tsx — permission-origin chip', () => {
  const { callSites } = load('../QuestionCard.tsx', ts.ScriptKind.TSX);

  it('derives the chip from the store’s permissionOrigin index', () => {
    expect(callSites.some((site) => site.includes('derivePermissionOrigin(origin)'))).toBe(true);
    expect(
      callSites.some(
        (site) => site.startsWith('useSubagentActivityStore(') && site.includes('permissionOrigin[')
      )
    ).toBe(true);
  });
});

describe('red line — chatSessions.ts stays untouched by T-34', () => {
  it('the red-line store never mentions subagent lanes', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../stores/chatSessions.ts', import.meta.url)),
      'utf8'
    );
    expect(source).not.toMatch(/subagent/i);
    expect(source).not.toContain('parentToolCallId');
  });
});
