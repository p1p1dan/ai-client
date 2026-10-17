// Moved from src/runtime/plugins/permissions/bash-analysis.ts (dsh-rebase P1-6a)

import { homedir } from 'node:os';
import { basename, posix, resolve, sep, win32 } from 'node:path';
import { isExplorationCommand } from '../runtimeShellPolicy.ts';
import { createPermissionError, type PermissionErrorFactory } from './errors.ts';
import { normalizeWindowsPathForm } from './windowsPaths.ts';

export interface BashAnalysis {
  paths: string[];
  commands: string[];
  unresolvedPaths: boolean;
  exploration: boolean;
  /**
   * dsh-rebase P1-6d: no session grant may cover this command, because part of
   * it is code the analysis could not read (`pwshAnalysis`). `analyzeBash`
   * never sets it.
   */
  ungrantable?: boolean;
  /**
   * Decision 191 (claude-sdk-engine ruling 27): the entries of `paths` the
   * command reaches only through the environment (`$HOME`, `$env:TEMP`, a
   * relative operand after `cd "$DIR"`), never by spelling them out. Full auto
   * treats them like an unresolved operand: they never make a command ask for
   * being outside the workspace. Every other check still reads them. Absent
   * when there is none.
   */
  parameterPaths?: string[];
}

/**
 * The part of a tree-sitter-bash syntax node the walk reads.
 *
 * Structural on purpose: this library never imports `web-tree-sitter`. Each
 * host loads the grammar its own way (the 1.0.x runtime through HostIo, the DSH
 * host from its own package) and hands the parser in; `web-tree-sitter`'s
 * `Parser` satisfies `BashParser` as it is.
 */
export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly hasError: boolean;
  readonly namedChildren: readonly BashSyntaxNode[];
  childForFieldName(fieldName: string): BashSyntaxNode | null;
  childrenForFieldName(fieldName: string): readonly BashSyntaxNode[];
}
export interface BashSyntaxTree {
  readonly rootNode: BashSyntaxNode;
  delete(): void;
}
export interface BashParser {
  parse(input: string): BashSyntaxTree | null;
}

interface ShellState {
  cwd: string;
  variables: Record<string, string | undefined>;
  /** Variables whose value came from the environment (decision 191). */
  fromEnv: Set<string>;
  /** `cwd` was reached through the environment (`cd "$DIR"`). */
  cwdFromEnv: boolean;
}

/** A copy for a nested scope: a subshell, a pipeline stage, `bash -c`. */
function forkState(state: ShellState): ShellState {
  return {
    cwd: state.cwd,
    variables: { ...state.variables },
    fromEnv: new Set(state.fromEnv),
    cwdFromEnv: state.cwdFromEnv,
  };
}

/**
 * Words that always exec another command with the rest of the line as its
 * arguments. The command that matters for policy is the one behind them, so
 * they are peeled off before the verb is judged.
 */
const WRAPPER_VERBS = [
  'command',
  'builtin',
  'exec',
  'timeout',
  'nice',
  'nohup',
  'time',
  'stdbuf',
  'setsid',
  'doas',
  'ionice',
  'chrt',
];
/**
 * Peel wrapper words off a command line.
 *
 * Returns the inner verb and how many arguments were consumed, or `undefined`
 * when the wrapped command cannot be read statically — the caller then marks
 * the whole command unresolved instead of judging the wrapper's own name.
 */
function unwrap(
  verb: string,
  args: readonly (string | undefined)[]
): { verb: string; offset: number } | undefined {
  let current = verb;
  let offset = 0;
  for (let rounds = 0; WRAPPER_VERBS.includes(current); rounds++) {
    if (rounds >= 4) return undefined;
    let index = offset;
    // A wrapper's own switches, plus the bare duration or priority `timeout`
    // and `nice` take, sit between it and the command it runs.
    while (index < args.length) {
      const word = args[index];
      if (word === undefined) return undefined;
      if (!word.startsWith('-') && !/^\d+(?:\.\d+)?[smhd]?$/.test(word)) break;
      index++;
    }
    const inner = args[index];
    if (inner === undefined) return undefined;
    current = basename(inner);
    offset = index + 1;
  }
  return { verb: current, offset };
}

/**
 * Bash commands are written with '/' even where node's `sep` is '\\' (Windows
 * plus Git Bash). Fold a command's separators onto the platform one so a
 * wildcard segment such as `conf/*` is still a single segment downstream.
 */
export function normalizeShellPath(path: string, separator: string = sep): string {
  return separator === '/' ? path : path.replaceAll('/', separator);
}
/** Split a path on the platform separator, tolerating the other one. */
export function splitShellPath(path: string, separator: string = sep): string[] {
  return separator === '/' ? path.split('/') : path.split(/[\\/]/);
}

/**
 * The single spelling one shell operand is registered under.
 *
 * Every downstream gate — the deny list, the workspace check, the canonical
 * re-check — reads the string this returns, so the Windows spellings have to be
 * folded HERE and not only inside `pathPolicy`: `containsPath` compares the
 * same string and would otherwise answer "outside the workspace" for a file
 * inside it, or the reverse (windows-01).
 */
export function shellOperandPath(
  text: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  const paths = platform === 'win32' ? win32 : posix;
  const target = normalizeWindowsPathForm(text, platform);
  return normalizeShellPath(
    paths.isAbsolute(target) ? target : `${cwd}${paths.sep}${target}`,
    paths.sep
  );
}

/**
 * Walk one bash command line and report what it touches.
 *
 * Adapted from the old permission plugin's AST approach. Synchronous: the
 * caller owns the parser (and the wasm behind it) and has it ready before
 * calling. Anything that cannot be analysed throws `invalid_tool_arguments`
 * through `createError` rather than returning an empty analysis.
 */
export function analyzeBash(
  parser: BashParser,
  command: string,
  cwd: string,
  env: Record<string, string>,
  createError: PermissionErrorFactory = createPermissionError
): BashAnalysis {
  const result: BashAnalysis = {
    paths: [],
    commands: [],
    unresolvedPaths: false,
    exploration: true,
  };
  const paths = new Set<string>();
  // Decision 191: which registered paths only the environment spelled.
  const environmentPaths = new Set<string>();
  const spelledPaths = new Set<string>();
  /** Set by `value` when it expanded a variable that came from the environment. */
  let readEnvironment = false;
  let visited = 0;
  /** `value`, and whether the environment supplied any of it. */
  function read(
    node: BashSyntaxNode,
    state: ShellState
  ): { text: string | undefined; env: boolean } {
    const outer = readEnvironment;
    readEnvironment = false;
    const text = value(node, state);
    const env = readEnvironment;
    readEnvironment = outer || env;
    return { text, env };
  }
  function value(node: BashSyntaxNode, state: ShellState): string | undefined {
    switch (node.type) {
      case 'command_name':
        return value(node.namedChildren[0], state);
      case 'number':
      case 'word': {
        let text = node.text.replace(/\\(.)/gs, '$1');
        if (text === '~' || text.startsWith('~/'))
          text = `${state.variables.HOME ?? homedir()}${text.slice(1)}`;
        if (text.startsWith('~')) {
          result.unresolvedPaths = true;
          return undefined;
        }
        return text;
      }
      case 'raw_string':
        return node.text.slice(1, -1);
      case 'string_content':
        return node.text.replace(/\\([$`"\\\n])/g, '$1');
      case 'string':
      case 'concatenation': {
        const parts = node.namedChildren.map((child) => value(child, state));
        return parts.every((part) => part !== undefined) ? parts.join('') : undefined;
      }
      case 'simple_expansion':
      case 'expansion': {
        if (
          node.namedChildren.length === 1 &&
          node.namedChildren[0].type === 'variable_name' &&
          /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(node.text)
        ) {
          const found = state.variables[node.namedChildren[0].text];
          if (found !== undefined) {
            if (state.fromEnv.has(node.namedChildren[0].text)) readEnvironment = true;
            return found;
          }
        }
        result.unresolvedPaths = true;
        return undefined;
      }
      default:
        result.unresolvedPaths = true;
        return undefined;
    }
  }
  /** Whether `text` is joined onto the current directory rather than standing alone. */
  function relativeOperand(text: string): boolean {
    const target = normalizeWindowsPathForm(text, process.platform);
    return !(process.platform === 'win32' ? win32 : posix).isAbsolute(target);
  }
  function note(path: string, env: boolean) {
    paths.add(path);
    (env ? environmentPaths : spelledPaths).add(path);
  }
  function register(text: string, state: ShellState, env: boolean) {
    if (!text) return;
    // Keep wildcard's static parent; glob expansion is handled by the caller.
    note(shellOperandPath(text, state.cwd), env || (state.cwdFromEnv && relativeOperand(text)));
  }
  function addPath(text: string | undefined, state: ShellState, env = false) {
    if (!text || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return;
    if (text.startsWith('-')) {
      const equals = text.indexOf('=');
      // `--file=x`, `-C/path`, `-tDIR`: a value glued to a switch is still an
      // operand. Register any single-letter switch with content behind it
      // rather than a fixed letter set; an extra in-workspace candidate costs
      // nothing, a dropped one escapes every deny and scope check.
      if (equals >= 0) register(text.slice(equals + 1), state, env);
      else if (/^-[A-Za-z].+/.test(text)) register(text.slice(2), state, env);
      return;
    }
    register(text, state, env);
    // `of=/outside/x` (dd), `TARGET=/outside` (make): without splitting the
    // value off, the whole word is joined onto cwd and a target outside the
    // workspace reads as one inside it.
    const equals = text.indexOf('=');
    if (equals > 0 && /^[A-Za-z_][\w.-]*=/.test(text)) {
      const operand = text.slice(equals + 1);
      if (!operand.startsWith('-')) register(operand, state, env);
    }
  }
  function assignment(node: BashSyntaxNode, state: ShellState) {
    const name = node.childForFieldName('name');
    const input = node.childForFieldName('value');
    if (name) {
      const assigned = input ? read(input, state) : { text: '', env: false };
      state.variables[name.text] = assigned.text;
      if (assigned.env) state.fromEnv.add(name.text);
      else state.fromEnv.delete(name.text);
    }
    if (input) visitSubstitutions(input, state, 0);
  }
  function parse(text: string, state: ShellState, depth: number) {
    if (depth > 8)
      throw createError('invalid_tool_arguments', 'nested shell exceeds analysis limit');
    const tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) {
      tree?.delete();
      throw createError('invalid_tool_arguments', 'bash command could not be parsed');
    }
    try {
      walk(tree.rootNode, state, depth);
    } finally {
      tree.delete();
    }
  }
  function walk(node: BashSyntaxNode, state: ShellState, depth: number) {
    if (++visited > 20_000)
      throw createError('invalid_tool_arguments', 'bash AST exceeds analysis limit');
    if (node.type === 'comment' || node.type === 'heredoc_start' || node.type === 'heredoc_end')
      return;
    if (node.type === 'variable_assignment') {
      assignment(node, state);
      result.exploration = false;
      return;
    }
    if (node.type === 'command') {
      const nameNode = node.childForFieldName('name');
      const nameRead = nameNode ? read(nameNode, state) : { text: undefined, env: false };
      const name = nameRead.text;
      // `$(which rm) -rf x` resolves to nothing statically, but the inner
      // command's own operands still have to reach the judgement.
      if (nameNode) visitSubstitutions(nameNode, state, depth);
      for (const prefix of node.namedChildren.filter(
        (child) => child.type === 'variable_assignment'
      ))
        visitSubstitutions(prefix, state, depth);
      const argumentNodes = node.childrenForFieldName('argument');
      const argReads = argumentNodes.map((arg) => read(arg, state));
      const args = argReads.map((arg) => arg.text);
      const unit = [name, ...args].filter((word) => word !== undefined).join(' ');
      result.commands.push(unit);
      result.exploration &&=
        Boolean(name) && args.every((arg) => arg !== undefined) && isExplorationCommand(unit);
      if (!name) result.unresolvedPaths = true;
      const verb = name ? basename(name) : '';
      // Policy rules are written against the bare verb (`rm *`), so the real
      // command has to be judged under that spelling however it was reached:
      // `/bin/rm`, `command rm`, `timeout 5 rm`.
      const inner = unwrap(verb, args);
      if (!inner) result.unresolvedPaths = true;
      const effectiveVerb = inner ? inner.verb : verb;
      const effectiveArgs = inner ? args.slice(inner.offset) : args;
      const effectiveEnv = (inner ? argReads.slice(inner.offset) : argReads).map((arg) => arg.env);
      const normalized = [effectiveVerb, ...effectiveArgs]
        .filter((word) => word !== undefined)
        .join(' ');
      if (effectiveVerb && normalized !== unit) result.commands.push(normalized);
      const shellVerb = ['bash', 'sh', 'zsh', 'dash'].includes(effectiveVerb);
      const switchIndex = shellVerb
        ? effectiveArgs.findIndex((arg) => arg !== undefined && /^-[a-z]*c[a-z]*$/.test(arg))
        : -1;
      const nestedIndex = switchIndex < 0 ? 0 : switchIndex + 1;
      const nestedScript = nestedIndex > 0 ? effectiveArgs[nestedIndex] : undefined;
      // A shell without `-c` runs a script file (or a terminal) whose contents
      // this analysis never sees; nothing about its operands is resolved.
      if (shellVerb && nestedScript === undefined) result.unresolvedPaths = true;
      if (nestedScript !== undefined) {
        const nestedState = forkState(state);
        for (const child of node.namedChildren.filter(
          (child) => child.type === 'variable_assignment'
        ))
          assignment(child, nestedState);
        parse(nestedScript, nestedState, depth + 1);
      }
      // Patterns and embedded programs are not themselves filesystem operands.
      const patternFirst = ['grep', 'rg', 'sed', 'awk'].includes(effectiveVerb);
      let skippedPattern = false;
      effectiveArgs.forEach((arg, index) => {
        if (index === nestedIndex && nestedIndex > 0) return;
        if (patternFirst && arg !== undefined) {
          const previous = effectiveArgs[index - 1];
          if (previous === '-f' || previous === '--file') {
            skippedPattern = true;
            addPath(arg, state, effectiveEnv[index]);
            return;
          }
          if (/^(?:-f.|--file=)/.test(arg)) {
            skippedPattern = true;
            addPath(arg.startsWith('-f') ? arg.slice(2) : arg.slice(7), state, effectiveEnv[index]);
            return;
          }
          if (previous === '-e' || previous === '--regexp' || previous === '--expression') {
            skippedPattern = true;
            return;
          }
          if (/^(?:-e.|--regexp=|--expression=)/.test(arg)) {
            skippedPattern = true;
            return;
          }
          if (previous === '-g' || previous === '--glob' || previous === '--iglob') return;
          if (arg === '--pre' || arg.startsWith('--pre=')) result.unresolvedPaths = true;
        }
        if (patternFirst && !skippedPattern && arg !== undefined && !arg.startsWith('-')) {
          skippedPattern = true;
          return;
        }
        addPath(arg, state, effectiveEnv[index]);
      });
      if (name?.includes('/')) addPath(name, state, nameRead.env);
      if (
        [
          'eval',
          'source',
          '.',
          'xargs',
          'sudo',
          'env',
          'python',
          'python3',
          'node',
          'perl',
          'ruby',
        ].includes(effectiveVerb)
      )
        result.unresolvedPaths = true;
      if (effectiveVerb === 'cd') {
        const at = effectiveArgs.findIndex((arg) => arg !== '--');
        // A bare `cd` names the home directory as plainly as `cd ~` does.
        const target = at < 0 ? state.variables.HOME : effectiveArgs[at];
        if (!target || target === '-' || effectiveArgs.some((arg) => arg === undefined))
          result.unresolvedPaths = true;
        else {
          state.cwdFromEnv =
            (at >= 0 && effectiveEnv[at]) || (state.cwdFromEnv && relativeOperand(target));
          state.cwd = resolve(state.cwd, target);
          state.variables.PWD = state.cwd;
          if (state.cwdFromEnv) state.fromEnv.add('PWD');
          else state.fromEnv.delete('PWD');
          note(state.cwd, state.cwdFromEnv);
        }
      }
      // A leading redirect (`> out echo hi`) and a here-string both hang off
      // the command's own `redirect` field rather than `argument`, so the
      // generic recursion below never reaches them.
      for (const redirect of node.childrenForFieldName('redirect')) walk(redirect, state, depth);
      for (const child of argumentNodes) visitSubstitutions(child, state, depth);
      return;
    }
    if (node.type === 'file_redirect') {
      for (const child of node.childrenForFieldName('destination')) {
        const target = read(child, state);
        addPath(target.text, state, target.env);
      }
      result.exploration = false;
    }
    if (node.type === 'herestring_redirect') {
      // The word is stdin data rather than a file, but register it anyway: a
      // denied name must not reach a command through this door, and
      // `<<< "$(cat .env)"` hides a whole command inside the operand.
      for (const child of node.namedChildren)
        if (child.type !== 'file_descriptor') {
          const word = read(child, state);
          addPath(word.text, state, word.env);
        }
      result.exploration = false;
      visitSubstitutions(node, state, depth);
      return;
    }
    if (['subshell', 'command_substitution', 'process_substitution'].includes(node.type)) {
      result.exploration = false;
      result.unresolvedPaths ||= node.type !== 'subshell';
      const nested = forkState(state);
      for (const child of node.namedChildren) walk(child, nested, depth + 1);
      return;
    }
    if (node.type === 'pipeline') {
      for (const child of node.namedChildren) walk(child, forkState(state), depth + 1);
      return;
    }
    if (
      [
        'if_statement',
        'for_statement',
        'while_statement',
        'case_statement',
        'function_definition',
      ].includes(node.type)
    ) {
      result.unresolvedPaths = true;
      result.exploration = false;
    }
    if (node.type === 'heredoc_body') {
      visitSubstitutions(node, state, depth);
      return;
    }
    for (const child of node.namedChildren) walk(child, state, depth);
  }
  function visitSubstitutions(node: BashSyntaxNode, state: ShellState, depth: number) {
    if (['command_substitution', 'process_substitution'].includes(node.type))
      walk(node, state, depth);
    else for (const child of node.namedChildren) visitSubstitutions(child, state, depth);
  }
  const fromEnv = new Set([...Object.keys(env), 'HOME']);
  fromEnv.delete('PWD');
  parse(
    command,
    {
      cwd,
      variables: { ...env, HOME: env.HOME ?? homedir(), PWD: cwd },
      fromEnv,
      cwdFromEnv: false,
    },
    0
  );
  result.paths = [...paths];
  const parameterPaths = [...environmentPaths].filter((path) => !spelledPaths.has(path));
  if (parameterPaths.length > 0) result.parameterPaths = parameterPaths;
  return result;
}
