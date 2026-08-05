import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

/**
 * Incident 2026-08-05 (context surface crash-on-open, resume item ②):
 * `ContextSurfaceView` selected its message bucket as
 *
 *   useChatSessionsStore((state) => activeSessionId ? (state.messages[id] ?? []) : [])
 *
 * and the app died on mount with "Maximum update depth exceeded" the moment a
 * session had no bucket yet. zustand v5 reads every selector through
 * `useSyncExternalStore`, which re-runs the selector after subscribing and
 * compares the result to the one it rendered with using `Object.is`. A freshly
 * built `[]` is never `Object.is`-equal to the previous freshly built `[]`, so
 * React concludes the store changed on every commit, calls `forceStoreRerender`
 * from a passive effect, and loops until the nested-update limit trips.
 *
 * This is a positive invariant over every renderer selector, not a pin on the
 * one site that failed: any NEW selector that builds its return value fails the
 * suite. The fix is always the same shape — return the stable snapshot
 * (`undefined` / the raw slice) and default with a module-level constant in the
 * component body, as `ContextSurfaceView`'s `EMPTY_MESSAGES` and
 * `messageQueue.ts`'s `EMPTY_QUEUE` do.
 *
 * Scope note: only the `useXStore(selector)` hook form is scanned.
 * `useXStore.getState().foo ?? []` is a plain read with no subscription and no
 * snapshot comparison, so `?? []` there is safe and stays legal — several call
 * sites in `ChatComposer.tsx` rely on it.
 */

const RENDERER_DIR = join(process.cwd(), 'src/renderer');

/** Array/object-producing members: a call to one allocates on every selector run. */
const ALLOCATING_METHODS = new Set([
  'map',
  'filter',
  'slice',
  'concat',
  'sort',
  'reverse',
  'flat',
  'flatMap',
  'splice',
]);

/** Statics whose every call allocates a fresh array/object. */
const ALLOCATING_STATICS = new Set([
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.assign',
  'Object.fromEntries',
  'Array.from',
  'Array.of',
]);

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function listRendererSources(): string[] {
  return (readdirSync(RENDERER_DIR, { recursive: true }) as string[])
    .map(String)
    .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('__tests__'))
    .map((p) => join(RENDERER_DIR, p));
}

/** `useChatSessionsStore(...)` / `useShellLayoutStore(...)` and friends. */
function isStoreHookCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && /^use[A-Z]\w*Store$/.test(node.expression.text);
}

/** True when evaluating this expression necessarily builds a new object each time. */
function allocatesFreshValue(node: ts.Expression): boolean {
  const expr = ts.isParenthesizedExpression(node) ? node.expression : node;

  if (ts.isArrayLiteralExpression(expr) || ts.isObjectLiteralExpression(expr)) {
    return true;
  }
  if (ts.isNewExpression(expr)) {
    return true;
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const access = expr.expression;
    if (ALLOCATING_METHODS.has(access.name.text)) {
      return true;
    }
    if (ALLOCATING_STATICS.has(access.getText())) {
      return true;
    }
  }
  // `a ?? []`, `cond ? x : {}`, `a || []` — the allocation hides in a branch.
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return allocatesFreshValue(expr.left) || allocatesFreshValue(expr.right);
    }
  }
  if (ts.isConditionalExpression(expr)) {
    return allocatesFreshValue(expr.whenTrue) || allocatesFreshValue(expr.whenFalse);
  }
  return false;
}

/** Every expression the selector can hand back, ignoring nested callbacks. */
function collectReturnedExpressions(selector: ts.ArrowFunction | ts.FunctionExpression) {
  const returned: ts.Expression[] = [];
  const body = selector.body;

  if (!ts.isBlock(body)) {
    returned.push(body);
    return returned;
  }
  const walk = (node: ts.Node): void => {
    // A nested function's `return` belongs to that function, not the selector.
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return returned;
}

function scanFile(path: string): Violation[] {
  const source = ts.createSourceFile(
    path,
    stripComments(readFileSync(path, 'utf8'), path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStoreHookCall(node)) {
      const [selector] = node.arguments;
      if (selector && (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector))) {
        for (const expression of collectReturnedExpressions(selector)) {
          if (!allocatesFreshValue(expression)) {
            continue;
          }
          const { line } = source.getLineAndCharacterOfPosition(expression.getStart(source));
          violations.push({
            file: path.slice(RENDERER_DIR.length + 1),
            line: line + 1,
            snippet: expression.getText(source).replace(/\s+/g, ' ').slice(0, 80),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return violations;
}

describe('zustand selector reference stability', () => {
  it('no renderer store selector returns a freshly built value', () => {
    const violations = listRendererSources().flatMap(scanFile);

    expect(
      violations.map((v) => `${v.file}:${v.line} → ${v.snippet}`),
      'A selector that allocates makes useSyncExternalStore see a changed store on ' +
        'every commit and re-render forever. Return the stable slice and default ' +
        'with a module-level constant in the component body instead.'
    ).toEqual([]);
  });

  it('detects the exact shape that crashed the context surface', () => {
    const path = join(RENDERER_DIR, '__probe__.tsx');
    const source = ts.createSourceFile(
      path,
      [
        'function View() {',
        '  const messages = useChatSessionsStore((state) =>',
        '    activeSessionId ? (state.messages[activeSessionId] ?? []) : []',
        '  );',
        '  const rows = useChatSessionsStore((state) => state.sessions.filter(Boolean));',
        '  const safe = useChatSessionsStore((state) => state.messages[id]);',
        '  const alsoSafe = useChatSessionsStore.getState().messages[id] ?? [];',
        '  return { messages, rows, safe, alsoSafe };',
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isStoreHookCall(node)) {
        const [selector] = node.arguments;
        if (selector && ts.isArrowFunction(selector)) {
          for (const expression of collectReturnedExpressions(selector)) {
            if (allocatesFreshValue(expression)) {
              found.push(expression.getText(source).replace(/\s+/g, ' '));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);

    // The two allocating selectors are caught; the stable slice and the
    // non-reactive `getState()` read are not.
    expect(found).toEqual([
      'activeSessionId ? (state.messages[activeSessionId] ?? []) : []',
      'state.sessions.filter(Boolean)',
    ]);
  });
});
