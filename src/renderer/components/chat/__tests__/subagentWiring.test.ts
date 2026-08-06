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

  it('the Collapsible default honors view.defaultOpen with the failed fallback', () => {
    expect(callSites).toContain('defaultOpen={view.defaultOpen ?? view.failed}');
    // The old failed-only literal must be gone — a second Collapsible with
    // the pre-T-34 default would silently ignore the panel's live-open rule.
    expect(callSites).not.toContain('defaultOpen={view.failed}');
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
