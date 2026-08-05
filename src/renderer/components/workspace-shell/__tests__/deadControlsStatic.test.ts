import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * T-23 (A06 honesty rules): the new shell must not contain controls that look
 * clickable but do nothing, nor hardcoded values dressed up as runtime state.
 *
 * Two layers, because they guard different things:
 * 1. A positive invariant over every workspace-shell .tsx: each <Button> /
 *    <button> JSX element must carry click semantics — onClick, a literal
 *    type="submit", a disabled state that isn't literally false, a render=
 *    wrapper that owns the click (TooltipTrigger/MenuTrigger idiom), or a
 *    props spread (a forwarding wrapper owns the handler; the scan cannot see
 *    through it, so the spread is a documented pass, not proof). This is the
 *    general rule — a NEW dead button fails the suite, not just a restored
 *    old one. Walks the real TypeScript AST (T-31 precedent), so braces or
 *    `>` inside attribute strings cannot derail it the way a text scan would.
 * 2. Pins for the five controls the 2026-07-28 A06 matrix flagged and T-23
 *    removed. These would stay red even if the control came back *wired*:
 *    browser/preview are rail-entered surfaces (registry slots), usage lives
 *    in WindowTitleBar's pill — re-adding a header entry is an architecture
 *    change and must consciously update this file.
 *
 * String pins read CODE, not prose (shared parser-backed strip), so comments
 * naming the banned patterns — like this one — don't trip the assertions.
 */

const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');

function listShellTsx(): string[] {
  return (readdirSync(SHELL_DIR, { recursive: true }) as string[])
    .map(String)
    .filter((p) => p.endsWith('.tsx') && !p.includes('__tests__'))
    .map((p) => join(SHELL_DIR, p));
}

function codeOf(path: string): string {
  return stripComments(readFileSync(path, 'utf8'), path);
}

/** True when this <Button>/<button> element carries click semantics (see header). */
function hasClickSemantics(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  for (const attr of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      return true;
    }
    if (!ts.isJsxAttribute(attr)) {
      continue;
    }
    const name = attr.name.getText();
    if (name === 'onClick' || name === 'render') {
      return true;
    }
    if (
      name === 'type' &&
      attr.initializer !== undefined &&
      ts.isStringLiteral(attr.initializer) &&
      attr.initializer.text === 'submit'
    ) {
      return true;
    }
    if (name === 'disabled') {
      // Bare `disabled` or any expression counts; a literal {false} is a
      // decoration, not a state, and must not excuse a handler-less button.
      const expr =
        attr.initializer !== undefined && ts.isJsxExpression(attr.initializer)
          ? attr.initializer.expression
          : undefined;
      if (expr?.kind !== ts.SyntaxKind.FalseKeyword) {
        return true;
      }
    }
  }
  return false;
}

function deadButtonViolations(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if ((tag === 'Button' || tag === 'button') && !hasClickSemantics(node)) {
        const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart(source));
        violations.push(`${path}:${line + 1} <${tag}> without click semantics`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe('workspace-shell dead-control invariant (T-23 / A06)', () => {
  it('every <Button>/<button> carries click semantics', () => {
    const violations = listShellTsx().flatMap(deadButtonViolations);
    expect(violations).toEqual([]);
  });
});

describe('MainHeader pins (T-23 removals)', () => {
  const CODE = codeOf(join(SHELL_DIR, 'MainHeader.tsx'));

  it('the hardcoded usage ring stays removed', () => {
    expect(CODE).not.toMatch(/UsageRing/);
  });

  it('browser/preview stay rail-entered surfaces — no header entry in any spelling', () => {
    expect(CODE).not.toMatch(/['"`]Browser['"`]/);
    expect(CODE).not.toMatch(/['"`]Window['"`]/);
    expect(CODE).not.toMatch(/\bGlobe\b|\bAppWindow\b/);
  });

  it('keeps HeaderIconButton onClick required so a dead header icon cannot compile', () => {
    expect(CODE).toMatch(/onClick: \(\) => void/);
    expect(CODE).not.toMatch(/onClick\?\s*:/);
  });

  it('workspace context survives the single line: chip with focus-reachable path tooltip (P-22)', () => {
    expect(CODE).toMatch(/TooltipTrigger/);
    expect(CODE).toMatch(/activeWorkspace\.path/);
  });

  it('the chip yields in the narrow-window crunch instead of clipping the actions', () => {
    // Codex final-verify major: a shrink-0 chip pushed the header buttons
    // past overflow-hidden at the 685px window minimum.
    expect(CODE).toContain('min-w-0 max-w-48');
    expect(CODE).not.toMatch(/max-w-48[^"']*shrink-0|shrink-0[^"']*max-w-48/);
  });

  it('title sits on the body-copy tier with a cross-platform weight (P-19)', () => {
    expect(CODE).toMatch(/text-markdown/);
    expect(CODE).toMatch(/leading-normal/);
    expect(CODE).toMatch(/font-semibold/);
    expect(CODE).not.toMatch(/text-sm/);
  });
});

describe('LeftNav pins (T-23 removals)', () => {
  const CODE = codeOf(join(SHELL_DIR, 'LeftNav.tsx'));

  it('the dead hamburger stays removed in any spelling', () => {
    expect(CODE).not.toMatch(/['"`]Menu['"`]/);
  });

  it('the dead Help button stays removed in any spelling', () => {
    expect(CODE).not.toMatch(/CircleHelp/);
    expect(CODE).not.toMatch(/['"`]Help['"`]/);
    expect(CODE).not.toMatch(/>\s*Help\s*</);
  });
});
