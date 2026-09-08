import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { isExplorationCommand } from './shell-policy.ts';

export interface BashAnalysis {
  paths: string[];
  commands: string[];
  unresolvedPaths: boolean;
  exploration: boolean;
}
interface ShellState {
  cwd: string;
  variables: Record<string, string | undefined>;
}
const require = createRequire(import.meta.url);

let sharedLanguage: Promise<Language> | undefined;
async function loadLanguage(io: RuntimeHostIoService): Promise<Language> {
  try {
    const wasm = await io.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), {
      maxBytes: 4 * 1024 * 1024,
      overflow: 'error',
    });
    await Parser.init({ wasmBinary: wasm.bytes });
    const grammar = await io.readFile(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'), {
      maxBytes: 4 * 1024 * 1024,
      overflow: 'error',
    });
    return await Language.load(grammar.bytes);
  } catch (error) {
    sharedLanguage = undefined;
    throw error;
  }
}

// Adapt the old permission plugin's AST approach, without importing its Pi SDK
// or filesystem code. WASM assets are read through the same HostIo as tool data.
export class BashAnalyzer {
  private ready?: Promise<Parser>;
  private readonly io: RuntimeHostIoService;
  constructor(io: RuntimeHostIoService) {
    this.io = io;
  }
  private async initialize(): Promise<Parser> {
    sharedLanguage ??= loadLanguage(this.io);
    const language = await sharedLanguage;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }
  async dispose(): Promise<void> {
    if (this.ready)
      await this.ready.then(
        (parser) => parser.delete(),
        () => {}
      );
  }
  async analyze(command: string, cwd: string, env: Record<string, string>): Promise<BashAnalysis> {
    this.ready ??= this.initialize();
    const parser = await this.ready;
    const result: BashAnalysis = {
      paths: [],
      commands: [],
      unresolvedPaths: false,
      exploration: true,
    };
    const paths = new Set<string>();
    let visited = 0;
    function value(node: SyntaxNode, state: ShellState): string | undefined {
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
            if (found !== undefined) return found;
          }
          result.unresolvedPaths = true;
          return undefined;
        }
        default:
          result.unresolvedPaths = true;
          return undefined;
      }
    }
    function addPath(text: string | undefined, state: ShellState) {
      if (!text || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return;
      if (text.startsWith('-')) {
        const equals = text.indexOf('=');
        if (equals >= 0) text = text.slice(equals + 1);
        else if (/^-[CILof].+/.test(text)) text = text.slice(2);
        else return;
      }
      // Keep wildcard's static parent; glob expansion is handled by the caller.
      paths.add(isAbsolute(text) ? text : `${state.cwd}${sep}${text}`);
    }
    function assignment(node: SyntaxNode, state: ShellState) {
      const name = node.childForFieldName('name');
      const input = node.childForFieldName('value');
      if (name) state.variables[name.text] = input ? value(input, state) : '';
      if (input) visitSubstitutions(input, state, 0);
    }
    function parse(text: string, state: ShellState, depth: number) {
      if (depth > 8)
        throw new RuntimeHostError('invalid_tool_arguments', 'nested shell exceeds analysis limit');
      const tree = parser.parse(text);
      if (!tree || tree.rootNode.hasError) {
        tree?.delete();
        throw new RuntimeHostError('invalid_tool_arguments', 'bash command could not be parsed');
      }
      try {
        walk(tree.rootNode, state, depth);
      } finally {
        tree.delete();
      }
    }
    function walk(node: SyntaxNode, state: ShellState, depth: number) {
      if (++visited > 20_000)
        throw new RuntimeHostError('invalid_tool_arguments', 'bash AST exceeds analysis limit');
      if (node.type === 'comment' || node.type === 'heredoc_start' || node.type === 'heredoc_end')
        return;
      if (node.type === 'variable_assignment') {
        assignment(node, state);
        result.exploration = false;
        return;
      }
      if (node.type === 'command') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? value(nameNode, state) : undefined;
        for (const prefix of node.namedChildren.filter(
          (child) => child.type === 'variable_assignment'
        ))
          visitSubstitutions(prefix, state, depth);
        const argumentNodes = node.childrenForFieldName('argument');
        const args = argumentNodes.map((arg) => value(arg, state));
        const unit = [name, ...args].filter((word) => word !== undefined).join(' ');
        result.commands.push(unit);
        result.exploration &&=
          Boolean(name) && args.every((arg) => arg !== undefined) && isExplorationCommand(unit);
        if (!name) result.unresolvedPaths = true;
        const verb = name ? basename(name) : '';
        const nestedIndex = ['bash', 'sh', 'zsh', 'dash'].includes(verb)
          ? args.findIndex((arg) => arg !== undefined && /^-[a-z]*c[a-z]*$/.test(arg)) + 1
          : 0;
        if (nestedIndex > 0 && args[nestedIndex] !== undefined) {
          const nestedState = { cwd: state.cwd, variables: { ...state.variables } };
          for (const child of node.namedChildren.filter(
            (child) => child.type === 'variable_assignment'
          ))
            assignment(child, nestedState);
          parse(args[nestedIndex], nestedState, depth + 1);
        }
        // Patterns and embedded programs are not themselves filesystem operands.
        const patternFirst = ['grep', 'rg', 'sed', 'awk'].includes(verb);
        let skippedPattern = false;
        args.forEach((arg, index) => {
          if (index === nestedIndex && nestedIndex > 0) return;
          if (patternFirst && arg !== undefined) {
            const previous = args[index - 1];
            if (previous === '-f' || previous === '--file') {
              skippedPattern = true;
              addPath(arg, state);
              return;
            }
            if (/^(?:-f.|--file=)/.test(arg)) {
              skippedPattern = true;
              addPath(arg.startsWith('-f') ? arg.slice(2) : arg.slice(7), state);
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
          addPath(arg, state);
        });
        if (name?.includes('/')) addPath(name, state);
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
          ].includes(verb)
        )
          result.unresolvedPaths = true;
        if (verb === 'cd') {
          const target = args.filter((arg) => arg !== '--')[0] ?? state.variables.HOME;
          if (!target || target === '-' || args.some((arg) => arg === undefined))
            result.unresolvedPaths = true;
          else {
            state.cwd = resolve(state.cwd, target);
            state.variables.PWD = state.cwd;
            paths.add(state.cwd);
          }
        }
        for (const child of argumentNodes) visitSubstitutions(child, state, depth);
        return;
      }
      if (node.type === 'file_redirect') {
        for (const child of node.childrenForFieldName('destination'))
          addPath(value(child, state), state);
        result.exploration = false;
      }
      if (['subshell', 'command_substitution', 'process_substitution'].includes(node.type)) {
        result.exploration = false;
        result.unresolvedPaths ||= node.type !== 'subshell';
        const nested = { cwd: state.cwd, variables: { ...state.variables } };
        for (const child of node.namedChildren) walk(child, nested, depth + 1);
        return;
      }
      if (node.type === 'pipeline') {
        for (const child of node.namedChildren)
          walk(child, { cwd: state.cwd, variables: { ...state.variables } }, depth + 1);
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
    function visitSubstitutions(node: SyntaxNode, state: ShellState, depth: number) {
      if (['command_substitution', 'process_substitution'].includes(node.type))
        walk(node, state, depth);
      else for (const child of node.namedChildren) visitSubstitutions(child, state, depth);
    }
    parse(command, { cwd, variables: { ...env, HOME: env.HOME ?? homedir(), PWD: cwd } }, 0);
    result.paths = [...paths];
    return result;
  }
}
