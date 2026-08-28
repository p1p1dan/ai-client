import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_HOST_PROTOCOL_VERSION } from '@shared/types/agentHost';
import {
  AGENT_DISPLAY_NAMES,
  AGENT_WIRE_NAMES,
  isAgentWireName,
  resolveAgentWireName,
  sessionAgent,
} from '@shared/types/agentWire';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// The parser-backed comment strip is shared repo-wide (see its header for why a
// regex pair is not good enough); this suite has to explain the very literal it
// bans, so it must scan code with the comments blanked out. Reaching into the
// renderer tree for it is a test-only edge — no shipped `src/shared` module
// imports anything from `src/renderer`.
import { stripComments } from '../../../renderer/components/chat/__tests__/stripComments';

/**
 * S2 slice 0 — the agent binding is an ABI, and three lookalike tables live in
 * this repo. These are the invariants that keep them apart, as assertions
 * rather than as review habits.
 *
 * The three tables, none of which converts into another:
 *   - `AgentWireName`  — which runtime a CHAT SESSION is bound to (persisted).
 *   - `BuiltinAgentId` — which CLI the TERMINAL can spawn.
 *   - `AIProvider`     — which provider runs a ONE-SHOT assistant.
 *
 * The failure this is aimed at is not a crash. It is a session that gets bound
 * to the wrong runtime because somebody wrote the default agent literal a
 * second time, or handed a value from one table to a consumer of another — and
 * the wrong binding is then written to `session-index.json`, where it outlives
 * the build that made the mistake.
 *
 * ## Why every rule below is an AST walk over a NODE, not a regex over a FILE
 *
 * The first version of this suite judged by file: a file that mentioned
 * `AIProvider` anywhere had every one of its `'claude-code'` literals waved
 * through, and a cast was suspicious only when the file happened to also spell
 * a second axis somewhere. Both are the wrong unit. U3 puts the default agent
 * for new chats into the global settings store — the very module that also
 * holds `provider: 'claude-code'` — so under a file-level exemption the one
 * literal this suite exists to ban would have landed unnoticed, in the one file
 * where it matters most. Every rule therefore decides on the literal's own
 * surroundings (its key, its annotation, the expression it falls back from) and
 * the exemption is the PROVIDER AXIS, not the file.
 *
 * Each rule is a module-level function called by both the tree scan and its
 * probe. A negative control that re-implements the rule proves only that the
 * copy still works, which is exactly the state this suite was in before.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../..');

const AGENT_WIRE_MODULE = path.join(SRC_DIR, 'shared/types/agentWire.ts');
const RUNTIME_EVENTS_MODULE = path.join(SRC_DIR, 'shared/types/runtimeEvents.ts');
const CLI_TYPES_MODULE = path.join(SRC_DIR, 'shared/types/cli.ts');
const AI_TYPES_MODULE = path.join(SRC_DIR, 'shared/types/ai.ts');
const SESSION_INDEX_SERVICE = path.join(SRC_DIR, 'main/services/chat/SessionIndexService.ts');

/** The legacy default, and the string this suite is mostly about. */
const LEGACY_LITERAL = 'claude-code';

/** The three tables, and the module that defines each. */
type Axis = 'AgentWireName' | 'BuiltinAgentId' | 'AIProvider';

const AXIS_MODULE: Record<Axis, string> = {
  AgentWireName: AGENT_WIRE_MODULE,
  BuiltinAgentId: CLI_TYPES_MODULE,
  AIProvider: AI_TYPES_MODULE,
};

const AXES = Object.keys(AXIS_MODULE) as Axis[];

/**
 * Every .ts/.tsx this repo owns — renderer, main, preload and agent-host, tests
 * excluded.
 *
 * `src/agent-host/node_modules` is excluded because it is not ours: it is
 * gitignored vendored dependency code, so scanning it makes the result depend
 * on whether someone has installed, and 1701 of the 2329 matching paths are
 * dependency sources whose `'claude-code'` occurrences say nothing about this
 * repo's invariants. The "scans are looking at the tree they claim to" case
 * below pins that the exclusion did not eat the tree.
 */
// Memoized: five rules walk the same tree, and the tree cannot change inside a
// run. Without this, each rule paid its own recursive readdir over ~800 files.
let sourceListCache: string[] | undefined;

function listSources(): string[] {
  if (sourceListCache !== undefined) return sourceListCache;
  sourceListCache = (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .map(String)
    .filter(
      (p) =>
        (p.endsWith('.ts') || p.endsWith('.tsx')) &&
        !p.includes('__tests__') &&
        !p.split(path.sep).includes('node_modules')
    )
    .map((p) => path.join(SRC_DIR, p));
  return sourceListCache;
}

// Memoized for the same reason. Probe sources never go through here — they are
// handed to `parse` directly — so nothing depends on re-reading a mutated file.
const readCache = new Map<string, string>();

function read(file: string): string {
  const cached = readCache.get(file);
  if (cached !== undefined) return cached;
  const raw = readFileSync(file, 'utf8');
  readCache.set(file, raw);
  return raw;
}

function rel(file: string): string {
  return path.relative(SRC_DIR, file);
}

/* -------------------------------------------------------------------------
 * Parsing. Every rule below takes (file, rawSource) and strips comments
 * itself, so a probe string goes through the exact same pipeline as a file on
 * disk — including the comment strip, which is where a hand-rolled probe would
 * otherwise diverge from production.
 * ---------------------------------------------------------------------- */

const parsedCache = new Map<string, ts.SourceFile>();

function parse(file: string, raw: string): ts.SourceFile {
  // Keyed on the RAW source, not the stripped one. Keying on the stripped text
  // meant `stripComments` — itself a full TS scanner pass — ran on every call
  // even when the parse was about to be served from cache, so the five tree
  // rules paid four redundant strips over the whole tree. Raw is an equally
  // sound key: same (file, raw) always yields the same stripped text.
  const key = `${file.length}:${file}${raw}`;
  const cached = parsedCache.get(key);
  if (cached !== undefined) return cached;
  const stripped = stripComments(raw, file);
  const source = ts.createSourceFile(
    file,
    stripped,
    ts.ScriptTarget.Latest,
    true,
    // `.ts` and `.tsx` are different grammars: `<AIProvider>x` is a type
    // assertion in one and an unclosed JSX element in the other.
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  parsedCache.set(key, source);
  return source;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
}

/* -------------------------------------------------------------------------
 * Axis inference. No type checker: building a Program over this tree costs
 * more than the whole suite and needs the dependency graph to be installed.
 * These are the syntactic signals instead, and they are read off the node —
 * never off the file.
 * ---------------------------------------------------------------------- */

/**
 * Which table a KEY belongs to. `agentId` is the terminal's builtin id and
 * `agent` is the chat session's wire name — the two are one character apart and
 * carry different value sets, which is most of why this suite exists.
 */
function keyAxis(name: string): Axis | null {
  const key = name.replace(/^['"`]|['"`]$/g, '');
  if (/agentid$/i.test(key)) return 'BuiltinAgentId';
  if (/agent$/i.test(key)) return 'AgentWireName';
  if (/provider$/i.test(key)) return 'AIProvider';
  return null;
}

/**
 * Which table a FREE VARIABLE belongs to, when nothing else declares it. Exact
 * names only, where the key rule matches suffixes: a field called
 * `defaultAgent` is a binding by construction, but a local called
 * `editingBuiltinAgent` is the terminal's id — the suffix rule read that one as
 * a chat binding and called an honest `as BuiltinAgentId` narrowing a relabel.
 */
function identifierAxis(name: string): Axis | null {
  const exact: Record<string, Axis | undefined> = {
    agent: 'AgentWireName',
    agentid: 'BuiltinAgentId',
    provider: 'AIProvider',
  };
  return exact[name.toLowerCase()] ?? null;
}

interface FileFacts {
  /** Local TYPE name → axis, so `import type { AIProvider as P }` still counts. */
  typeNames: Map<string, Axis>;
  /** Local name imported from an axis-defining module → that axis. */
  imported: Map<string, Axis>;
  /** Local variable/parameter → axis, from annotations, destructuring, initializers. */
  locals: Map<string, Axis>;
}

const factsCache = new WeakMap<ts.SourceFile, FileFacts>();

function factsOf(source: ts.SourceFile): FileFacts {
  const cached = factsCache.get(source);
  if (cached !== undefined) return cached;

  const typeNames = new Map<string, Axis>(AXES.map((axis) => [axis, axis]));
  const imported = new Map<string, Axis>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const target = specifierTarget(source.fileName, statement.moduleSpecifier);
    const bindings = statement.importClause.namedBindings;
    if (statement.importClause.name && target) {
      imported.set(statement.importClause.name.text, target);
    }
    if (bindings && ts.isNamespaceImport(bindings) && target) {
      imported.set(bindings.name.text, target);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        // The name in the DEFINING module, not the local alias: an axis type
        // renamed on import is the same table under a different label.
        const canonical = (element.propertyName ?? element.name).text;
        if ((AXES as string[]).includes(canonical)) {
          typeNames.set(element.name.text, canonical as Axis);
        }
        if (target) imported.set(element.name.text, target);
      }
    }
  }

  const facts: FileFacts = { typeNames, imported, locals: new Map() };

  // Pass 1 — declared types and destructured keys.
  eachNode(source, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
      const declared = node.type ? typeAxis(node.type, facts) : null;
      if (declared && ts.isIdentifier(node.name)) {
        facts.locals.set(node.name.text, declared);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const key = (element.propertyName ?? element.name).getText(source);
          const axis = keyAxis(key);
          if (axis) facts.locals.set(element.name.text, axis);
        }
      }
    }
  });

  // Pass 2 — initializers, twice, so `const a = s.agent; const b = a;` resolves.
  for (let round = 0; round < 2; round += 1) {
    eachNode(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      if (!ts.isIdentifier(node.name) || facts.locals.has(node.name.text)) return;
      const axis = expressionAxis(node.initializer, facts);
      if (axis) facts.locals.set(node.name.text, axis);
    });
  }

  factsCache.set(source, facts);
  return facts;
}

/**
 * Which table a TYPE NODE names. Ambiguity (`Record<AIProvider, AgentWireName>`)
 * answers `null` on purpose: an ambiguous annotation must not exempt a literal.
 */
function typeAxis(node: ts.TypeNode, facts: FileFacts): Axis | null {
  const found = new Set<Axis>();
  eachNode(node, (child) => {
    if (ts.isIdentifier(child)) {
      const axis = facts.typeNames.get(child.text);
      if (axis) found.add(axis);
    }
  });
  return found.size === 1 ? [...found][0] : null;
}

/** Which table an EXPRESSION's value comes from, as far as syntax can tell. */
function expressionAxis(node: ts.Node | undefined, facts: FileFacts, depth = 0): Axis | null {
  if (!node || depth > 8) return null;
  const next = (child: ts.Node | undefined): Axis | null => expressionAxis(child, facts, depth + 1);

  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return next(node.expression);
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return typeAxis(node.type, facts) ?? next(node.expression);
  }
  if (ts.isTypeAssertionExpression(node)) {
    return typeAxis(node.type, facts) ?? next(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) return next(node.operand);
  if (ts.isBinaryExpression(node)) return next(node.left) ?? next(node.right);
  if (ts.isConditionalExpression(node)) {
    return next(node.whenTrue) ?? next(node.whenFalse) ?? next(node.condition);
  }
  if (ts.isPropertyAccessExpression(node)) return keyAxis(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    return isStringish(arg) ? keyAxis(arg.text) : null;
  }
  if (ts.isCallExpression(node)) {
    // `sessionAgent(session)` / `resolveAgentWireName(raw)` — a call into an
    // axis module returns that axis.
    return ts.isIdentifier(node.expression)
      ? (facts.imported.get(node.expression.text) ?? null)
      : null;
  }
  if (ts.isIdentifier(node)) {
    return (
      facts.locals.get(node.text) ?? facts.imported.get(node.text) ?? identifierAxis(node.text)
    );
  }
  return null;
}

/** Both spellings of a plain string constant; the second one used to be invisible. */
function isStringish(
  node: ts.Node | undefined
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

/**
 * Which table a LITERAL is being used as, decided by walking outward from the
 * literal and stopping at the first surrounding node that answers.
 *
 * Nearest-wins is the whole point: `{ defaultAgent: 'claude-code' }` sitting
 * inside a settings object that is elsewhere full of `AIProvider` answers
 * `AgentWireName`, because the walk stops at its own key and never reaches the
 * ambient annotation.
 */
function literalAxisContext(literal: ts.Node, facts: FileFacts): Axis | null {
  let current: ts.Node = literal;
  let parent: ts.Node | undefined = literal.parent;

  while (parent) {
    const axis = axisFromParent(current, parent, facts);
    if (axis) return axis;
    current = parent;
    parent = parent.parent;
  }
  return null;
}

function axisFromParent(current: ts.Node, parent: ts.Node, facts: FileFacts): Axis | null {
  if (ts.isPropertyAssignment(parent)) {
    // As a VALUE the key decides; as a KEY (`'claude-code': […]`) nothing is
    // decided here and the walk continues to the object's annotation.
    return current === parent.initializer ? keyAxis(parent.name.getText()) : null;
  }
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name ? keyAxis(parent.name.getText()) : null;
  }
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === current ? parent.right : parent.left;
    return expressionAxis(other, facts);
  }
  if (ts.isConditionalExpression(parent)) {
    return current === parent.condition ? null : expressionAxis(parent.condition, facts);
  }
  if (ts.isCaseClause(parent)) {
    const block = parent.parent;
    const statement = block?.parent;
    return statement && ts.isSwitchStatement(statement)
      ? expressionAxis(statement.expression, facts)
      : null;
  }
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    return typeAxis(parent.type, facts);
  }
  if (ts.isTypeAssertionExpression(parent)) {
    return typeAxis(parent.type, facts);
  }
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
    return parent.type ? typeAxis(parent.type, facts) : null;
  }
  if (ts.isTypeAliasDeclaration(parent)) {
    // `type AIProvider = 'claude-code' | …` — the declaration of the axis.
    return facts.typeNames.get(parent.name.text) ?? null;
  }
  if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === current)) {
    return ts.isIdentifier(parent.expression)
      ? (facts.imported.get(parent.expression.text) ?? null)
      : null;
  }
  if (ts.isFunctionLike(parent)) {
    // Covers both `function f(): AIProvider { return '…' }` (reached through
    // the return statement) and a concise arrow body.
    const declared = (parent as ts.SignatureDeclaration).type;
    return declared ? typeAxis(declared, facts) : null;
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Rule 1 — no second default for a missing binding.
 * ---------------------------------------------------------------------- */

/**
 * `session.agent ?? 'claude-code'` and every alias of it: element access,
 * destructured name, a `const` that merely holds the read, an
 * `=== undefined ? … : …` ternary, and a template literal on the right-hand
 * side. Falling back to a VARIABLE stays legal — that is what `sessionAgent()`
 * and `resolveAgentWireName()` do, and they are where the policy lives.
 */
function scanInlineAgentDefaults(file: string, raw: string): string[] {
  const source = parse(file, raw);
  if (file === AGENT_WIRE_MODULE) return [];
  const facts = factsOf(source);
  const offenders: string[] = [];

  eachNode(source, (node) => {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const isFallback =
        operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
      if (
        isFallback &&
        isStringish(node.right) &&
        expressionAxis(node.left, facts) === 'AgentWireName'
      ) {
        offenders.push(`${rel(file)}:${lineOf(source, node)}`);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const branchLiteral = isStringish(node.whenTrue) || isStringish(node.whenFalse);
      if (branchLiteral && expressionAxis(node.condition, facts) === 'AgentWireName') {
        offenders.push(`${rel(file)}:${lineOf(source, node)}`);
      }
    }
  });

  return offenders;
}

/* -------------------------------------------------------------------------
 * Rule 2 — the legacy literal has exactly one home.
 * ---------------------------------------------------------------------- */

/**
 * `'claude-code'` occurrences that are not on the provider axis.
 *
 * Two file-scoped exemptions survive, and only two:
 *
 *  1. `shared/types/agentWire.ts` — the one home, value position included.
 *  2. `shared/types/runtimeEvents.ts` in TYPE position only —
 *     `SessionPermissionPolicy` is a discriminated union and a discriminant has
 *     to be spelled out. A value-position literal there is still an offender.
 *
 * Everything else is decided per literal: `'claude-code'` is ALSO the name of a
 * PROVIDER (commit messages, code review, todo polish), so the exemption is
 * "this node is on the AIProvider axis" — read through a `provider` key, typed
 * by an `AIProvider` annotation (alias included), switched on a provider, or
 * spelled inside the `AIProvider` declaration itself.
 */
function scanLegacyLiterals(file: string, raw: string): string[] {
  const source = parse(file, raw);
  if (file === AGENT_WIRE_MODULE) return [];
  const facts = factsOf(source);
  const offenders: string[] = [];

  eachNode(source, (node) => {
    if (!isStringish(node) || node.text !== LEGACY_LITERAL) return;
    const typePosition = ts.isLiteralTypeNode(node.parent);
    if (file === RUNTIME_EVENTS_MODULE && typePosition) return;
    if (literalAxisContext(node, facts) === 'AIProvider') return;
    offenders.push(`${rel(file)}:${lineOf(source, node)}`);
  });

  return offenders;
}

/* -------------------------------------------------------------------------
 * Rule 3 — the defining modules never reach for each other.
 * ---------------------------------------------------------------------- */

interface ModuleRef {
  kind: string;
  specifier: string;
  line: number;
}

/**
 * Every way one module can name another: plain and type-only imports,
 * side-effect imports, re-exports (`export … from`, `export * from`),
 * `import x = require(…)`, dynamic `import(…)`, `require(…)` and the
 * `import('…').Type` type node. The regex this replaces saw the first of those.
 */
function moduleReferences(file: string, raw: string): ModuleRef[] {
  const source = parse(file, raw);
  const refs: ModuleRef[] = [];
  const add = (kind: string, specifier: ts.Node | undefined, at: ts.Node): void => {
    if (!specifier) return;
    const text = isStringish(specifier) ? specifier.text : specifier.getText(source);
    refs.push({ kind, specifier: text, line: lineOf(source, at) });
  };

  eachNode(source, (node) => {
    if (ts.isImportDeclaration(node)) {
      add(node.importClause ? 'import' : 'side-effect import', node.moduleSpecifier, node);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add('re-export', node.moduleSpecifier, node);
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add('import=require', node.moduleReference.expression, node);
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const arg = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
      add('import type node', arg, node);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add('dynamic import', node.arguments[0], node);
        return;
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add('require', node.arguments[0], node);
      }
    }
  });

  return refs;
}

function formatRef(file: string, ref: ModuleRef): string {
  return `${rel(file)}:${ref.line} ${ref.kind} ${ref.specifier}`;
}

/** Module specifier → the absolute, extension-less module it names, if knowable. */
function specifierTarget(fromFile: string, specifier: ts.Node): Axis | null {
  const resolved = resolveSpecifier(fromFile, specifier);
  if (!resolved) return null;
  return AXES.find((axis) => moduleKey(AXIS_MODULE[axis]) === resolved) ?? null;
}

function resolveSpecifier(fromFile: string, specifier: ts.Node | string): string | null {
  const text =
    typeof specifier === 'string' ? specifier : isStringish(specifier) ? specifier.text : null;
  if (text === null) return null;
  let base: string | null = null;
  if (text.startsWith('.')) base = path.resolve(path.dirname(fromFile), text);
  else if (text.startsWith('@shared/')) base = path.join(SRC_DIR, 'shared', text.slice(8));
  else if (text.startsWith('@/')) base = path.join(SRC_DIR, 'renderer', text.slice(2));
  return base === null ? null : moduleKey(base);
}

function moduleKey(file: string): string {
  return file.replace(/\.(ts|tsx|js|jsx)$/, '');
}

/** References from `file` that land on `target` — resolved, not text-matched. */
function referencesTo(file: string, raw: string, target: string): ModuleRef[] {
  const key = moduleKey(target);
  const name = path.basename(key);
  return moduleReferences(file, raw).filter((ref) => {
    const resolved = resolveSpecifier(file, ref.specifier);
    if (resolved !== null) return resolved === key;
    // A computed specifier cannot be resolved statically; name it and it still
    // counts, because a module that builds its own path to another axis is
    // exactly the edge this bans.
    return new RegExp(`(^|[^A-Za-z])${name}(['"\`]|$)`).test(ref.specifier);
  });
}

/* -------------------------------------------------------------------------
 * Rule 4 — no cast relabels one axis as another.
 * ---------------------------------------------------------------------- */

/**
 * `x as AIProvider`, `<AIProvider>x` and `x satisfies AIProvider`, with the
 * target read through the import alias map, and the SOURCE judged on the
 * expression itself rather than on whether the file happens to mention a second
 * table somewhere. `settings.provider as AIProvider` is ordinary narrowing;
 * `entry.agent as AIProvider` is a relabel.
 */
function scanAxisCasts(file: string, raw: string): string[] {
  const source = parse(file, raw);
  const facts = factsOf(source);
  const offenders: string[] = [];

  eachNode(source, (node) => {
    const cast =
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
        ? node
        : null;
    if (!cast) return;
    const target = typeAxis(cast.type, facts);
    if (!target) return;
    const from = expressionAxis(cast.expression, facts);
    if (from && from !== target) {
      offenders.push(`${rel(file)}:${lineOf(source, cast)} ${from} → ${target}`);
    }
  });

  return offenders;
}

/* -------------------------------------------------------------------------
 * The tree scans.
 *
 * These four parse every `.ts`/`.tsx` under `src/` — ~800 files — so vitest's
 * 5s default is the wrong budget for them, not a signal that something is
 * slow. Measured on this machine (2026-08-09, after the read/parse memoization
 * above): first rule 3069ms cold, the rest <250ms each off the shared cache;
 * the whole file 3660ms. That left 39% headroom against 5s, which a loaded
 * machine eats — the gate went yellow-then-green on a retry once already.
 * An explicit budget is the honest fix: the work is genuinely this size, and a
 * timeout is meant to catch a hang, not to referee a known-heavy scan.
 * ---------------------------------------------------------------------- */
const TREE_SCAN_TIMEOUT_MS = 30_000;

describe('the default agent literal has exactly one home', () => {
  it(
    'nobody defaults an agent binding to a string literal in place',
    () => {
      const offenders = listSources().flatMap((file) => scanInlineAgentDefaults(file, read(file)));

      expect(
        offenders,
        'Call `sessionAgent(session)` (or `resolveAgentWireName(raw)` on the disk ' +
          'side) instead. An inline literal is a second answer to "what does a ' +
          'missing binding mean", and the two answers will drift.'
      ).toEqual([]);
    },
    TREE_SCAN_TIMEOUT_MS
  );

  it(
    'no `claude-code` outside agentWire.ts and the AIProvider axis',
    () => {
      const offenders = listSources().flatMap((file) => scanLegacyLiterals(file, read(file)));

      expect(
        offenders,
        'The chat-session binding literal belongs in shared/types/agentWire.ts. ' +
          'If this is the AIProvider axis instead, say so on the node — a ' +
          '`provider` key, an `AIProvider` annotation, a switch on a provider — ' +
          'not by mentioning the type somewhere else in the file.'
      ).toEqual([]);
    },
    TREE_SCAN_TIMEOUT_MS
  );

  it(
    'the scans are looking at the tree they claim to',
    () => {
      // A tree-wide scan whose answer is `[]` is indistinguishable from a scan
      // that reads nothing, so the inputs are pinned too.
      const files = listSources();
      expect(files.length).toBeGreaterThan(300);
      expect(files).toContain(AGENT_WIRE_MODULE);
      expect(files).toContain(path.join(SRC_DIR, 'renderer/stores/settings/defaults.ts'));
      expect(files.some((file) => file.split(path.sep).includes('node_modules'))).toBe(false);

      // …and the literal rule really does meet its literal: these are the
      // provider-axis occurrences it is deliberately letting through.
      const carriers = files.filter((file) => read(file).includes(LEGACY_LITERAL));
      expect(carriers.length).toBeGreaterThan(5);
    },
    TREE_SCAN_TIMEOUT_MS
  );
});

describe('the legacy-literal scan catches every shape it exists for', () => {
  // One probe file, every escape the file-level version let through. It is fed
  // to the production function, so narrowing that function reddens these.
  const PROBE = path.join(SRC_DIR, 'renderer/__probe__.ts');

  it('reports agent-axis literals and only those', () => {
    const source = [
      "import type { AIProvider as Provider } from '@shared/types/ai';", // 1
      "const selectedProvider: Provider = 'codex-cli';", // 2
      'const raw = session.agent;', // 3
      "const aliased = raw ?? 'claude-code';", // 4  offender
      'const templated = raw ?? `claude-code`;', // 5  offender
      'const { agent } = session;', // 6
      "const destructured = agent || 'claude-code';", // 7  offender
      "const element = session['agent'] ?? 'claude-code';", // 8  offender
      "const ternary = session.agent === undefined ? 'claude-code' : session.agent;", // 9  offender
      "const settingsDefault = { defaultAgent: 'claude-code', provider: 'claude-code' };", // 10 offender (first only)
      "const compared = settings.provider === 'claude-code';", // 11
      "const table: Record<Provider, string> = { 'claude-code': 'x' };", // 12
      'function pick(p: Provider) {', // 13
      '  switch (p) {', // 14
      "    case 'claude-code':", // 15
      '      return 1;', // 16
      '  }', // 17
      '}', // 18
      "const annotated: Provider = 'claude-code';", // 19
      "const returned = (): Provider => 'claude-code';", // 20
    ].join('\n');

    expect(scanLegacyLiterals(PROBE, source)).toEqual([
      'renderer/__probe__.ts:4',
      'renderer/__probe__.ts:5',
      'renderer/__probe__.ts:7',
      'renderer/__probe__.ts:8',
      'renderer/__probe__.ts:9',
      'renderer/__probe__.ts:10',
    ]);
  });

  it('an AIProvider mention no longer launders the rest of the file', () => {
    // The exact shape U3 makes likely: the global settings module names
    // `AIProvider` for the one-shot assistants AND holds the new-chat default.
    const source = [
      "import type { AIProvider } from '@shared/types/ai';",
      "const providerDefault: AIProvider = 'claude-code';",
      "export const defaults = { agent: 'claude-code' };",
    ].join('\n');

    expect(scanLegacyLiterals(PROBE, source)).toEqual(['renderer/__probe__.ts:3']);
  });

  it('sees the literal through a comment strip and both quote shapes', () => {
    const source = [
      '// a comment naming claude-code must not count',
      "/* nor a block one: session.agent ?? 'claude-code' */",
      'const fromTemplate = row.agent ?? `claude-code`;',
      'const fromDouble = row.agent ?? "claude-code";',
    ].join('\n');

    expect(scanLegacyLiterals(PROBE, source)).toEqual([
      'renderer/__probe__.ts:3',
      'renderer/__probe__.ts:4',
    ]);
  });
});

describe('the inline-default scan catches every shape it exists for', () => {
  const PROBE = path.join(SRC_DIR, 'renderer/__probe__.ts');

  it('reports literal fallbacks off an agent read, whatever the alias', () => {
    const source = [
      "const direct = session.agent ?? 'claude-code';", // 1  offender
      'const or = entry.agent || "codex";', // 2  offender
      'const viaVariable = session.agent ?? LEGACY_AGENT;', // 3
      'const { agent: alias } = row;', // 4
      "const destructured = alias ?? 'codex';", // 5  offender
      "const element = row['agent'] || 'codex';", // 6  offender
      "const ternary = row.agent === undefined ? 'codex' : row.agent;", // 7  offender
      'const templated = row.agent ?? `codex`;', // 8  offender
      "const otherAxis = settings.provider ?? 'claude-code';", // 9
      "const alsoOther = terminal.agentId ?? 'claude';", // 10
    ].join('\n');

    expect(scanInlineAgentDefaults(PROBE, source)).toEqual([
      'renderer/__probe__.ts:1',
      'renderer/__probe__.ts:2',
      'renderer/__probe__.ts:5',
      'renderer/__probe__.ts:6',
      'renderer/__probe__.ts:7',
      'renderer/__probe__.ts:8',
    ]);
  });
});

describe('the three agent tables stay disconnected', () => {
  it('agentWire.ts names no other module, in any of the eight ways', () => {
    expect(
      moduleReferences(AGENT_WIRE_MODULE, read(AGENT_WIRE_MODULE)).map((ref) =>
        formatRef(AGENT_WIRE_MODULE, ref)
      ),
      'agentWire.ts is read by shared types, main, agent-host and the renderer ' +
        'store alike; a dependency of its own is also the first edge between ' +
        'two of the three axes.'
    ).toEqual([]);
  });

  it('the defining modules never reach for one another', () => {
    const offenders: string[] = [];
    for (const from of AXES) {
      const file = AXIS_MODULE[from];
      const raw = read(file);
      for (const to of AXES) {
        if (to === from) continue;
        for (const ref of referencesTo(file, raw, AXIS_MODULE[to])) {
          offenders.push(`${formatRef(file, ref)} (${from} → ${to})`);
        }
      }
    }

    expect(
      offenders,
      'Each module defines a different axis; an edge between two of them is how ' +
        'a value from one table starts flowing into the other.'
    ).toEqual([]);
  });

  it('the module-reference scan sees every spelling of a dependency', () => {
    // Fed to the production scan, from the module the rule protects.
    const source = [
      "import '@shared/types/agentWire';", // 1  side-effect
      "import type { AgentWireName } from './agentWire';", // 2  type-only
      "export { AGENT_WIRE_NAMES } from './agentWire';", // 3  re-export
      "export * from './agentWire';", // 4  star re-export
      "const late = await import('./agentWire');", // 5  dynamic
      "const older = require('./agentWire');", // 6  require
      "import legacy = require('./agentWire');", // 7  import=require
      "type Borrowed = import('./agentWire').AgentWireName;", // 8  import type node
      "import { unrelated } from './somewhereElse';", // 9  not this axis
    ].join('\n');

    const refs = moduleReferences(AI_TYPES_MODULE, source);
    expect(refs.map((ref) => `${ref.line} ${ref.kind}`)).toEqual([
      '1 side-effect import',
      '2 import',
      '3 re-export',
      '4 re-export',
      '5 dynamic import',
      '6 require',
      '7 import=require',
      '8 import type node',
      '9 import',
    ]);

    // …and all eight of the agentWire ones are attributed to the agentWire axis.
    expect(referencesTo(AI_TYPES_MODULE, source, AGENT_WIRE_MODULE).map((ref) => ref.line)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8]
    );
  });

  it(
    'no cast relabels one axis as another',
    () => {
      const offenders = listSources().flatMap((file) => scanAxisCasts(file, read(file)));

      expect(
        offenders,
        'The three tables answer three different questions and their values do ' +
          'not correspond. Map explicitly if a mapping is genuinely needed; a ' +
          'cast just relabels one axis as another.'
      ).toEqual([]);
    },
    TREE_SCAN_TIMEOUT_MS
  );

  it('the cast scan sees aliases, angle brackets and satisfies', () => {
    const PROBE = path.join(SRC_DIR, 'shared/__probe__.ts');
    const source = [
      "import type { AIProvider as Provider } from '@shared/types/ai';", // 1
      "import type { BuiltinAgentId } from '@shared/types/cli';", // 2
      "import { CLAUDE_CODE_AGENT, sessionAgent } from '@shared/types/agentWire';", // 3
      'const aliasCast = session.agent as Provider;', // 4  offender
      'const angleCast = <Provider>session.agent;', // 5  offender
      'const satisfied = sessionAgent(session) satisfies Provider;', // 6  offender
      'const importedValue = CLAUDE_CODE_AGENT as BuiltinAgentId;', // 7  offender
      'const viaLocal = wire as Provider;', // 8  offender
      'const narrowing = settings.provider as Provider;', // 9
      'const unknownSource = fromUser as Provider;', // 10
      'const constAssertion = [1, 2] as const;', // 11
      'const editing = editingBuiltinAgent as BuiltinAgentId;', // 12
    ].join('\n');
    // `wire` gets its axis from the annotation below, which is why line 8 is an
    // offender: the source axis is read off the expression, not off the file.
    const withDeclaration = `${source}\nconst wire: AgentWireName = CLAUDE_CODE_AGENT;`;

    expect(scanAxisCasts(PROBE, withDeclaration)).toEqual([
      'shared/__probe__.ts:4 AgentWireName → AIProvider',
      'shared/__probe__.ts:5 AgentWireName → AIProvider',
      'shared/__probe__.ts:6 AgentWireName → AIProvider',
      'shared/__probe__.ts:7 AgentWireName → BuiltinAgentId',
      'shared/__probe__.ts:8 AgentWireName → AIProvider',
    ]);
  });
});

describe('pinned wire facts', () => {
  it('AGENT_WIRE_NAMES is exactly the persisted list, in order', () => {
    // This is an ABI, not a label: the values are written into
    // `session-index.json`, so renaming one orphans every row already on disk
    // and reordering changes nothing except the day someone assumes an index.
    // Appending is the only legal edit, and it belongs with the reader that
    // can actually run the new agent.
    expect(AGENT_WIRE_NAMES).toEqual(['claude-code', 'codex', 'pi']);
    expect(Object.keys(AGENT_DISPLAY_NAMES).sort()).toEqual([...AGENT_WIRE_NAMES].sort());
  });

  it('AGENT_HOST_PROTOCOL_VERSION stays 1', () => {
    // Multi-agent support is optional fields and new error-code values only.
    // Bumping on one side of the protocol while the other stays put turns
    // `protocol_mismatch` from a real signal into noise.
    expect(AGENT_HOST_PROTOCOL_VERSION).toBe(1);
  });

  it('[W-1] SessionStatusEvent.payload optional keys stay exactly {retry, liveness}', () => {
    // F2 (S0, 2026-08-18 watchdog redesign spec §3.4/§12.1): `liveness` rides
    // this payload as a THIRD optional field, same precedent as `retry`
    // (SessionRetryInfo, E11) — an optional-field addition, protocol version
    // unchanged. This pins the SET so a later addition that types a fourth
    // optional key straight onto the literal (instead of asking whether it
    // belongs on a new event type) breaks here first.
    const source = parse(RUNTIME_EVENTS_MODULE, read(RUNTIME_EVENTS_MODULE));
    let optionalKeys: string[] | undefined;
    eachNode(source, (node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'SessionStatusEvent') return;
      for (const member of node.members) {
        if (
          !ts.isPropertySignature(member) ||
          !member.type ||
          !ts.isIdentifier(member.name) ||
          member.name.text !== 'payload' ||
          !ts.isTypeLiteralNode(member.type)
        ) {
          continue;
        }
        optionalKeys = member.type.members
          .filter(
            (m): m is ts.PropertySignature =>
              ts.isPropertySignature(m) && !!m.questionToken && ts.isIdentifier(m.name)
          )
          .map((m) => (m.name as ts.Identifier).text);
      }
    });
    expect(optionalKeys?.sort()).toEqual(['liveness', 'retry']);
  });

  it('[W-1a] SessionLivenessNote field set stays exactly {source, budgetMs, reason, degraded}, all required', () => {
    // Companion pin to [W-1]: the note's OWN shape, not just where it rides.
    // §3.4 dropped the arbitration draft's `retryCount` (D3: no field without a
    // judging use — the same payload already has `retry: SessionRetryInfo` as
    // the single source of truth for attempt counts), so a fifth field
    // reappearing here — `retryCount` or otherwise — is exactly the regression
    // this guards.
    const source = parse(RUNTIME_EVENTS_MODULE, read(RUNTIME_EVENTS_MODULE));
    let fields: Array<{ name: string; optional: boolean }> | undefined;
    eachNode(source, (node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'SessionLivenessNote') return;
      fields = node.members
        .filter(
          (m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name)
        )
        .map((m) => ({ name: (m.name as ts.Identifier).text, optional: !!m.questionToken }));
    });
    expect(fields?.map((f) => f.name).sort()).toEqual(['budgetMs', 'degraded', 'reason', 'source']);
    expect(fields?.every((f) => !f.optional)).toBe(true);
  });

  it('session-index.json stays a bare JSON array', () => {
    // An envelope (`{schemaVersion, entries}`) makes an OLDER build's `for-of`
    // throw; its catch only warns and starts empty, and its next flush writes
    // `[]` back over the file. Every session index, silently gone. A version
    // marker can only ever be an optional per-entry field.
    const service = stripComments(read(SESSION_INDEX_SERVICE), SESSION_INDEX_SERVICE).replace(
      /\s+/g,
      ' '
    );

    expect(service).toContain('const parsed = JSON.parse(content) as SessionIndexEntry[];');
    expect(service).toContain('for (const entry of parsed) {');
    expect(service).toContain('const entries = [...this.entries.values()];');
    expect(service).toContain('await writeJsonAtomically(path, entries);');
    expect(service).not.toContain('schemaVersion');
  });
});

describe('resolveAgentWireName is the single fallback point', () => {
  it('treats a missing value as the legacy agent', () => {
    expect(resolveAgentWireName(undefined)).toBe('claude-code');
    expect(resolveAgentWireName(null)).toBe('claude-code');
    expect(resolveAgentWireName('')).toBe('claude-code');
  });

  it('passes known slugs through', () => {
    for (const name of AGENT_WIRE_NAMES) {
      expect(resolveAgentWireName(name)).toBe(name);
      expect(isAgentWireName(name)).toBe(true);
    }
  });

  it('refuses to guess at an unknown slug', () => {
    // Written by a NEWER build (the user downgraded). Guessing would run the
    // session against the wrong runtime; `null` means "hide the row", and the
    // entry stays on disk so upgrading brings it back.
    expect(resolveAgentWireName('gemini')).toBeNull();
    expect(resolveAgentWireName('claude')).toBeNull();
    expect(isAgentWireName('claude')).toBe(false);
    expect(isAgentWireName(undefined)).toBe(false);
  });

  it('sessionAgent reads a materialized binding without inventing a second default', () => {
    expect(sessionAgent({ agent: 'codex' })).toBe('codex');
    expect(sessionAgent({})).toBe('claude-code');
  });
});
