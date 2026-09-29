// New in dsh-rebase P1-6d: a conservative lexical reading of one PowerShell command line.

/**
 * What one `pwsh` command line touches, read without PowerShell (decision 046).
 *
 * DSH's only shell on Windows is `pwsh` (`pwsh -Command <command>`), and the
 * gate needs the same four answers from it that `analyzeBash` gives for bash:
 *
 *  - `paths`: every operand that could name a file, spelled for this host;
 *  - `commands`: one entry per command segment, its name normalized (aliases to
 *    their cmdlet, case folded) so a grant for `Get-ChildItem` also covers `ls`,
 *    `dir` and `gci`, and a user's `bash` policy rules can match the line;
 *  - `unresolvedPaths`: something here could not be read, so `auto` asks;
 *  - `exploration`: only inspects, so plan mode may run it.
 *
 * There is no parser behind this — a small lexer reads the shapes models write
 * (cmdlets and native programs, parameters, quotes, `$env:` variables,
 * redirections, pipelines, `;` / `&&` / `||`) and treats everything else as
 * unreadable. Unreadable is never guessed at: it is `unresolvedPaths`, which
 * asks under every gear but `bypass`. Two kinds are kept apart:
 *
 *  - **opaque text** — a construct whose meaning this lexer does not know (a
 *    variable other than `$env:` / `$HOME` / `$PWD`, `$( )`, `( )`, a script
 *    block, `@( )`, splatting, a here-string, a backtick, the `&` and `.`
 *    call operators, a keyword, a provider drive such as `HKCU:` or `Env:`,
 *    a UNC path, `--%`). The segment is unresolved AND ungrantable: a session
 *    grant for the command's name must not cover code nobody could read.
 *  - **opaque program** — a well-formed command that runs something this
 *    analysis cannot see into (`python x.py`, `Import-Module`). Unresolved, but
 *    grantable by its prefix, exactly as bash treats `python` and `node`.
 *    Programs that run a STRING or another shell (`Invoke-Expression`,
 *    `Start-Process`, `pwsh -Command`, `cmd /c`, ...) are ungrantable too.
 *
 * Literal words inside an opaque region are still registered as operands, so
 * the bundled deny list (`.env`, `~/.ssh/*`, `*.key`) keeps its floor even
 * under `bypass`, as `analyzeBash` keeps it by walking command substitutions.
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { BashAnalysis } from './bashWalker.ts';
import { createPermissionError, type PermissionErrorFactory } from './errors.ts';
import { pathPolicy } from './pathPolicy.ts';
import {
  isKnownPwshCommand,
  isPwshCommandName,
  isUngrantablePwshCommand,
  normalizePwshCommandName,
  pwshProgramStem,
} from './pwshNames.ts';

export {
  isKnownPwshCommand,
  isPwshCommandName,
  isUngrantablePwshCommand,
  normalizePwshCommandName,
  PWSH_TOOL,
  pwshProgramStem,
} from './pwshNames.ts';

/** Tokens past this are refused, as `analyzeBash` refuses an oversized AST. */
const TOKEN_LIMIT = 20_000;
/** Opaque regions longer than this are not scanned for literal words (they stay unresolved). */
const LITERAL_SCAN_LIMIT = 65_536;

/**
 * Programs whose effect is decided by a file this analysis never reads — the
 * same list `analyzeBash` marks unresolved (interpreters), plus PowerShell's
 * own module loader and default-handler launch. Unresolved; still grantable
 * by prefix (`python script.py`), as for bash.
 */
const OPAQUE_PROGRAMS = new Set(['python', 'python3', 'py', 'node', 'perl', 'ruby']);
const OPAQUE_CMDLETS = new Set(['Import-Module', 'Invoke-Item']);

/** Read-only commands plan mode may run (design shard 03 §11), plus bash's `echo` / `which`. */
const EXPLORATION_CMDLETS = new Set([
  'Get-ChildItem',
  'Get-Content',
  'Select-String',
  'Get-Location',
  'Test-Path',
  'Resolve-Path',
  'Get-Item',
  'Measure-Object',
  'Select-Object',
  'Sort-Object',
  'Where-Object',
  'Write-Output',
  'Get-Command',
]);
/** The read-only git subcommands `isExplorationCommand` allows for bash. */
const GIT_READ_ONLY = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
]);
const EXPLORATION_FORBIDDEN_FLAG =
  /^(?:--output(?:=|$)|--exec(?:=|$)|--pre(?:=|$)|--pre-glob(?:=|$)|--config(?:=|$)|-i$|--ext-diff|--textconv)/;

/** Programs whose first positional argument is a pattern, not a file (as for bash's grep / rg). */
const PATTERN_FIRST_PROGRAMS = new Set(['grep', 'rg', 'findstr']);

/** `Select-String` parameters that take a value, so the word after them is not the positional pattern. */
const SELECT_STRING_VALUE_PARAMETERS = [
  '-path',
  '-literalpath',
  '-include',
  '-exclude',
  '-encoding',
  '-context',
  '-culture',
  '-inputobject',
];
function takesSelectStringValue(parameter: string): boolean {
  return (
    parameter.length >= 3 &&
    SELECT_STRING_VALUE_PARAMETERS.some((candidate) => candidate.startsWith(parameter))
  );
}

/** Characters PowerShell reads as quotes or dashes but a reader takes for text. */
const LOOKALIKES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u2013\u2014\u2015]/;

// ---- lexer ------------------------------------------------------------------

type Part = { lit: string } | { variable: string };

interface WordToken {
  kind: 'word';
  start: number;
  end: number;
  parts: Part[];
  /** A construct inside this word that the lexer does not read. */
  opaque: boolean;
  /** Began with a quote: a string, never a parameter, and an expression at command position. */
  quoted: boolean;
  /** Literal words found inside opaque regions of this word, for the deny list. */
  nested: string[];
}
interface OperatorToken {
  kind: 'op';
  op: ';' | '|' | '&&' | '||' | '&';
  start: number;
  end: number;
}
interface RedirectToken {
  kind: 'redirect';
  /** `2>&1` and friends: no file. */
  merge: boolean;
  start: number;
  end: number;
}
type Token = WordToken | OperatorToken | RedirectToken;

const REDIRECT = /(?:[1-6*])?>>?(?:&[12])?/y;
/** A variable name, with an optional scope or drive (`env:PATH`, `global:x`). */
const VARIABLE_NAME = /[\p{L}\p{N}_]+(?::[\p{L}\p{N}_]+)?/uy;
const CLOSER: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/**
 * Literal words of an opaque region: quoted strings with nothing to expand,
 * and bare runs of path characters. A variable (`$_.Name`) or a parameter
 * (`-like`) is not an operand.
 */
const LITERAL_WORD =
  /\x27((?:[^\x27]|\x27\x27)*)\x27|\x22((?:[^\x22`$]|\x22\x22)*)\x22|(\$?[\p{L}\p{N}_.~\\/:*?-]+)/gu;
function literalWords(text: string): string[] {
  // A region this large is a payload (a here-string body), opaque either way.
  if (text.length > LITERAL_SCAN_LIMIT) return [];
  const words: string[] = [];
  for (const match of text.matchAll(LITERAL_WORD)) {
    if (match[1] !== undefined) words.push(match[1].replaceAll('\x27\x27', '\x27'));
    else if (match[2] !== undefined) words.push(match[2].replaceAll('\x22\x22', '\x22'));
    else if (match[3] && !match[3].startsWith('$') && !match[3].startsWith('-'))
      words.push(match[3]);
  }
  return words.filter((word) => word.length > 0);
}

function isSpace(c: string): boolean {
  return c !== '\n' && c !== '\r' && /\s/.test(c);
}

function lex(src: string, fail: () => never): { tokens: Token[]; opaque: boolean } {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let opaque = LOOKALIKES.test(src);
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > TOKEN_LIMIT) fail();
  };

  /** From an opener at `i` to its closer; quotes are skipped so `')'` does not close. */
  function skipRegion(): string {
    const from = i;
    const stack = [CLOSER[src[i]] ?? ')'];
    i++;
    while (i < n && stack.length > 0) {
      const c = src[i];
      if (c === '\x27' || c === '\x22') {
        skipQuoted(c);
        continue;
      }
      if (c === '`') {
        i += 2;
        continue;
      }
      if (c in CLOSER) stack.push(CLOSER[c]);
      else if (c === stack[stack.length - 1]) stack.pop();
      i++;
    }
    return src.slice(from, i);
  }
  /** Past a quoted string starting at `i`; true when it was terminated. */
  function skipQuoted(quote: string): boolean {
    i++;
    while (i < n) {
      const c = src[i];
      if (quote === '\x22' && c === '`') {
        i += 2;
        continue;
      }
      if (c === quote) {
        if (src[i + 1] === quote) {
          i += 2;
          continue;
        }
        i++;
        return true;
      }
      i++;
    }
    return false;
  }
  function opaqueRegion(word: WordToken): void {
    word.opaque = true;
    word.nested.push(...literalWords(skipRegion()));
  }
  function hereString(word: WordToken): void {
    const quote = src[i + 1];
    const from = i;
    const close = src.indexOf(`\n${quote}@`, i + 2);
    i = close < 0 ? n : close + 3;
    word.opaque = true;
    word.nested.push(...literalWords(src.slice(from + 2, close < 0 ? n : close)));
  }
  /** `$name`, `${name}` or `$env:NAME` at `i`; anything else a variable can be is opaque. */
  function variable(word: WordToken, inString: boolean): void {
    const next = src[i + 1];
    if (next === '(') {
      i++;
      opaqueRegion(word);
      return;
    }
    if (next === '{') {
      const close = src.indexOf('}', i + 2);
      if (close < 0) {
        word.opaque = true;
        i = n;
        return;
      }
      word.parts.push({ variable: src.slice(i + 2, close) });
      i = close + 1;
      return;
    }
    VARIABLE_NAME.lastIndex = i + 1;
    const name = VARIABLE_NAME.exec(src)?.[0];
    if (!name) {
      if (next !== undefined && /[?^$]/.test(next)) {
        word.opaque = true;
        i += 2;
        return;
      }
      word.parts.push({ lit: '$' });
      i++;
      return;
    }
    word.parts.push({ variable: name });
    i += 1 + name.length;
    // Member access and indexing, outside a string: `$HOME.Length`, `$args[0]`.
    if (!inString && (src[i] === '.' || src[i] === '[')) word.opaque = true;
  }
  function singleQuoted(word: WordToken): void {
    i++;
    let text = '';
    while (i < n) {
      if (src[i] === '\x27') {
        if (src[i + 1] === '\x27') {
          text += '\x27';
          i += 2;
          continue;
        }
        i++;
        word.parts.push({ lit: text });
        return;
      }
      text += src[i++];
    }
    word.parts.push({ lit: text });
    word.opaque = true;
  }
  function doubleQuoted(word: WordToken): void {
    i++;
    let text = '';
    const flush = () => {
      if (text) word.parts.push({ lit: text });
      text = '';
    };
    while (i < n) {
      const c = src[i];
      if (c === '\x22') {
        if (src[i + 1] === '\x22') {
          text += '\x22';
          i += 2;
          continue;
        }
        i++;
        flush();
        return;
      }
      if (c === '`') {
        word.opaque = true;
        i += 2;
        continue;
      }
      if (c === '$') {
        flush();
        variable(word, true);
        continue;
      }
      text += c;
      i++;
    }
    flush();
    word.opaque = true;
  }
  function readWord(): WordToken {
    const start = i;
    const word: WordToken = {
      kind: 'word',
      start,
      end: start,
      parts: [],
      opaque: false,
      quoted: src[i] === '\x27' || src[i] === '\x22',
      nested: [],
    };
    let text = '';
    const flush = () => {
      if (text) word.parts.push({ lit: text });
      text = '';
    };
    while (i < n) {
      const c = src[i];
      if (isSpace(c) || '\n\r;|&,)}<>'.includes(c)) break;
      if (c === '\x27') {
        flush();
        singleQuoted(word);
        continue;
      }
      if (c === '\x22') {
        flush();
        doubleQuoted(word);
        continue;
      }
      if (c === '`') {
        // An escape or a line continuation: what follows is not what it looks like.
        word.opaque = true;
        i += 2;
        continue;
      }
      if (c === '$') {
        flush();
        variable(word, false);
        continue;
      }
      if (c === '@' && i === start) {
        const next = src[i + 1];
        if (next === '\x27' || next === '\x22') {
          hereString(word);
          continue;
        }
        if (next === '(' || next === '{') {
          i++;
          opaqueRegion(word);
          continue;
        }
        if (next !== undefined && /[\p{L}\p{N}_]/u.test(next)) {
          // Splatting: `@params` expands a variable into parameters.
          word.opaque = true;
          i++;
          continue;
        }
      }
      if (c === '(' || c === '{' || (c === '[' && i === start)) {
        flush();
        opaqueRegion(word);
        continue;
      }
      text += c;
      i++;
    }
    flush();
    word.end = i;
    return word;
  }

  while (i < n) {
    const c = src[i];
    if (isSpace(c) || c === ',') {
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      push({ kind: 'op', op: ';', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '<' && src[i + 1] === '#') {
      // A block comment is harmless, but it is also where a lexer this small
      // would start disagreeing with PowerShell about what follows.
      opaque = true;
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ';') {
      push({ kind: 'op', op: ';', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      const double = src[i + 1] === c;
      const op = double ? (c === '|' ? '||' : '&&') : c;
      push({ kind: 'op', op, start: i, end: i + (double ? 2 : 1) });
      i += double ? 2 : 1;
      continue;
    }
    REDIRECT.lastIndex = i;
    const redirect = c === '>' || /[1-6*]/.test(c) ? REDIRECT.exec(src) : null;
    if (redirect?.[0].includes('>')) {
      push({
        kind: 'redirect',
        merge: redirect[0].includes('&'),
        start: i,
        end: REDIRECT.lastIndex,
      });
      i = REDIRECT.lastIndex;
      continue;
    }
    if (c === '<' || c === ')' || c === '}' || c === ']') {
      // `<` is reserved in PowerShell; a stray closer means the lexer lost count.
      opaque = true;
      i++;
      continue;
    }
    push(readWord());
  }
  return { tokens, opaque };
}

// ---- analysis ---------------------------------------------------------------

export interface PwshAnalysisOptions {
  /** Whose path rules apply; defaults to the host's. DSH runs pwsh on Windows only. */
  platform?: NodeJS.Platform;
  /** `$HOME` and `~`; defaults to USERPROFILE (Windows) or HOME, then the OS home. */
  home?: string;
  createError?: PermissionErrorFactory;
}

interface Segment {
  tokens: Array<WordToken | RedirectToken>;
  start: number;
  end: number;
  /** Behind the `&` call operator: `& $tool`, `& 'C:\x y\z.exe'`. */
  invoked: boolean;
  /** Followed by a lone `&`: runs as a background job (PowerShell 7). */
  background: boolean;
}

function splitSegments(tokens: Token[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  const open = (at: number): Segment => {
    const segment = current ?? {
      tokens: [],
      start: at,
      end: at,
      invoked: false,
      background: false,
    };
    current = segment;
    return segment;
  };
  const close = () => {
    if (current && (current.tokens.length > 0 || current.invoked)) segments.push(current);
    current = undefined;
  };
  for (const token of tokens) {
    if (token.kind === 'op') {
      if (token.op === '&' && (current === undefined || current.tokens.length === 0)) {
        open(token.start).invoked = true;
        continue;
      }
      if (token.op === '&' && current) current.background = true;
      close();
      continue;
    }
    const segment = open(token.start);
    segment.tokens.push(token);
    segment.end = token.end;
  }
  close();
  return segments;
}

/**
 * A `Set-Location` / `Push-Location` parameter, as PowerShell binds an
 * abbreviation: the target (`-Path`, `-LiteralPath` and their aliases), the
 * `-PassThru` switch, or one this analysis does not follow.
 */
function locationParameter(parameter: string): 'path' | 'switch' | undefined {
  if (parameter === '-lp' || parameter === '-pspath') return 'path';
  if (parameter.length >= 4 && '-passthru'.startsWith(parameter)) return 'switch';
  if (
    parameter.length >= 2 &&
    ('-path'.startsWith(parameter) || '-literalpath'.startsWith(parameter))
  )
    return 'path';
  return undefined;
}

/** `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\x` -> `\\srv\x`: an addressing prefix, not part of the name. */
function stripExtendedPrefix(path: string): string {
  const extended = /^[\\/]{2}[?.][\\/]/.exec(path);
  if (!extended) return path;
  const rest = path.slice(extended[0].length);
  return /^UNC[\\/]/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
}

/**
 * Read one `pwsh` command line. Never throws for a command it does not
 * understand — that is `unresolvedPaths` — only for one too large to read
 * (`invalid_tool_arguments`, as `analyzeBash` does).
 */
export function analyzePwsh(
  command: string,
  cwd: string,
  env: Record<string, string>,
  options: PwshAnalysisOptions = {}
): BashAnalysis {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const createError = options.createError ?? createPermissionError;
  const envValue = (name: string): string | undefined => {
    if (!windows) return env[name] || undefined;
    const key = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase()
    );
    return key === undefined ? undefined : env[key] || undefined;
  };
  const home = options.home ?? (windows ? envValue('USERPROFILE') : envValue('HOME')) ?? homedir();

  const { tokens, opaque: lexOpaque } = lex(command, () => {
    throw createError('invalid_tool_arguments', 'pwsh command exceeds analysis limit');
  });
  const paths = new Set<string>();
  const commands: string[] = [];
  let unresolvedPaths = lexOpaque;
  let ungrantable = lexOpaque;
  let exploration = !lexOpaque;
  let cwdNow = cwd;
  /** A `cd -`, `popd` or `cd $x` happened: every relative path after it is a guess. */
  let cwdLost = false;

  const resolveVariable = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    if (lower === 'null') return '';
    if (lower === 'true') return 'True';
    if (lower === 'false') return 'False';
    if (lower === 'home') return home;
    if (lower === 'pwd') return cwdLost ? undefined : cwdNow;
    if (lower.startsWith('env:')) return envValue(name.slice(4));
    return undefined;
  };
  const resolveWord = (word: WordToken): string | undefined => {
    if (word.opaque) return undefined;
    let text = '';
    for (const part of word.parts) {
      if ('lit' in part) text += part.lit;
      else {
        const value = resolveVariable(part.variable);
        if (value === undefined) return undefined;
        text += value;
      }
    }
    return text;
  };

  /**
   * Where one operand points, without registering it: `path` to check, and
   * `opaque` when where it points cannot be known. `providerPaths`: the
   * command is a cmdlet, so a drive-qualified word may name a PowerShell
   * provider (`HKCU:`, `Env:`, `Function:`) rather than a file.
   */
  const operand = (value: string, providerPaths: boolean): { path?: string; opaque?: true } => {
    if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return {};
    let text = value;
    if (text === '~' || /^~[\\/]/.test(text)) text = `${home}${text.slice(1)}`;
    else if (text.startsWith('~')) return { opaque: true };
    if (providerPaths && /^[A-Za-z][\w.-]+:/.test(text)) return { opaque: true };
    if (!windows) return { path: posix.isAbsolute(text) ? text : `${cwdNow}/${text}` };
    text = stripExtendedPrefix(text);
    if (/^[\\/]{2}/.test(text)) {
      // UNC: resolving it would reach the network before anyone approved the
      // call. A name the deny list refuses as written is still registered —
      // the shell path check refuses it before it resolves anything.
      return pathPolicy(text, { platform, home }) === 'deny'
        ? { path: text, opaque: true }
        : { opaque: true };
    }
    // `C:foo` and bare `C:` are relative to that drive's own current directory.
    if (/^[A-Za-z]:(?![\\/])/.test(text)) return { opaque: true };
    if (/^[\\/]/.test(text)) {
      const drive = /^[A-Za-z]:/.exec(cwdNow)?.[0];
      if (!drive) return { opaque: true };
      text = `${drive}${text}`;
    }
    const absolute = (win32.isAbsolute(text) ? text : `${cwdNow}\\${text}`).replaceAll('/', '\\');
    return {
      path: /^[a-z]:/.test(absolute) ? absolute[0].toUpperCase() + absolute.slice(1) : absolute,
    };
  };

  for (const segment of splitSegments(tokens)) {
    const raw = command.slice(segment.start, segment.end).trim();
    let opaqueText = segment.invoked || segment.background || cwdLost;
    let opaqueProgram = false;
    let writesFile = false;
    const opaqueWord = () => {
      opaqueText = true;
    };
    const register = (value: string, providerPaths: boolean) => {
      const target = operand(value, providerPaths);
      if (target.path !== undefined) paths.add(target.path);
      if (target.opaque) opaqueWord();
    };

    // Redirections and their targets; everything else is the command itself.
    const words: WordToken[] = [];
    const targets: WordToken[] = [];
    for (let index = 0; index < segment.tokens.length; index++) {
      const token = segment.tokens[index];
      if (token.kind === 'word') {
        words.push(token);
        continue;
      }
      if (token.merge) continue;
      const target = segment.tokens[index + 1];
      if (target?.kind !== 'word') {
        opaqueWord();
        continue;
      }
      targets.push(target);
      index++;
    }
    for (const word of [...words, ...targets]) {
      if (word.opaque) opaqueWord();
      for (const literal of word.nested) register(literal, false);
    }
    for (const target of targets) {
      const value = resolveWord(target);
      if (value === undefined) {
        opaqueWord();
        continue;
      }
      // `2>$null` discards; anything else is a file PowerShell writes (Out-File).
      if (value === '') continue;
      writesFile = true;
      register(value, true);
    }

    const head = words[0];
    const headValue = head && !head.quoted ? resolveWord(head) : undefined;
    if (headValue === undefined || !isPwshCommandName(headValue)) {
      // An expression, an assignment, a call through `&`, a keyword: register
      // what can be read, then give up on the segment.
      for (const word of words) {
        const value = resolveWord(word);
        if (value !== undefined && !value.startsWith('-')) register(value, true);
      }
      unresolvedPaths = true;
      ungrantable = true;
      exploration = false;
      commands.push(raw);
      continue;
    }

    const name = normalizePwshCommandName(headValue);
    const stem = pwshProgramStem(name);
    const cmdlet = isKnownPwshCommand(name) || /^[a-z]+-[a-z]+$/i.test(name);
    if (/[\\/]/.test(headValue)) register(headValue, false);
    if (isUngrantablePwshCommand(name)) {
      opaqueProgram = true;
      ungrantable = true;
    }
    if (OPAQUE_PROGRAMS.has(stem) || OPAQUE_CMDLETS.has(name)) opaqueProgram = true;

    const args = words.slice(1);
    const values: string[] = [name];
    const isParameter = (word: WordToken, value: string) =>
      !word.quoted && value.length > 1 && value.startsWith('-');
    // Select-String's pattern, and grep / rg / findstr's: not a file.
    const patternParam = (parameter: string) =>
      name === 'Select-String'
        ? parameter.length >= 5 && '-pattern'.startsWith(parameter)
        : ['-e', '--regexp', '-f', '--file'].includes(parameter);
    const patternFirst = name === 'Select-String' || PATTERN_FIRST_PROGRAMS.has(stem);
    let positionalPatternPending =
      patternFirst &&
      !args.some((word) => {
        const value = resolveWord(word);
        return (
          value !== undefined &&
          isParameter(word, value) &&
          patternParam(value.split(/[:=]/)[0].toLowerCase())
        );
      });
    const location = name === 'Set-Location' || name === 'Push-Location';
    // A string handed to something that runs it: its words still meet the deny list.
    const runsCode = isUngrantablePwshCommand(name);
    let skipNextValue = false;
    let namedValueNext = false;
    let locationTarget: string | undefined;
    let locationOpaque = false;
    for (const word of args) {
      const value = resolveWord(word);
      if (value === undefined) {
        opaqueWord();
        locationOpaque = true;
        continue;
      }
      values.push(value);
      if (value === '--%') {
        // Stop-parsing: the rest of the line goes to the program verbatim.
        opaqueWord();
        break;
      }
      if (runsCode) for (const literal of literalWords(value)) register(literal, false);
      if (skipNextValue) {
        skipNextValue = false;
        continue;
      }
      if (namedValueNext) {
        // The value of a named parameter, not the positional pattern.
        namedValueNext = false;
        register(value, cmdlet);
        continue;
      }
      if (isParameter(word, value)) {
        const separator = cmdlet ? value.indexOf(':') : value.indexOf('=');
        const parameter = (separator > 0 ? value.slice(0, separator) : value).toLowerCase();
        if (patternFirst && patternParam(parameter)) {
          // `-f file` names a file of patterns: that one is an operand.
          const file = !cmdlet && (parameter === '-f' || parameter === '--file');
          if (separator > 0) {
            if (file) register(value.slice(separator + 1), false);
          } else if (!file) skipNextValue = true;
          continue;
        }
        if (name === 'Select-String' && separator < 0 && takesSelectStringValue(parameter)) {
          namedValueNext = true;
          continue;
        }
        if (location) {
          // Only the target and `-PassThru`: `-StackName` and friends are not read here.
          const kind = locationParameter(parameter);
          if (kind === undefined) locationOpaque = true;
          else if (kind === 'path' && separator > 0) locationTarget ??= value.slice(separator + 1);
          continue;
        }
        if (separator > 0) register(value.slice(separator + 1), cmdlet);
        // `-C/path`, `-oout.txt`: a native program's value glued to its switch.
        else if (!cmdlet && /^-[A-Za-z].+/.test(value)) register(value.slice(2), false);
        continue;
      }
      // A native program's `/switch` (`ipconfig /all`, `robocopy a b /MIR`) is not an operand.
      if (windows && !cmdlet && /^\/[A-Za-z?][\w?:+.-]*$/.test(value)) continue;
      if (positionalPatternPending) {
        positionalPatternPending = false;
        continue;
      }
      if (location) {
        if (locationTarget !== undefined) locationOpaque = true;
        locationTarget ??= value;
        continue;
      }
      register(value, cmdlet);
    }

    if (location) {
      const target =
        locationOpaque || locationTarget === undefined || /^[+-]$/.test(locationTarget)
          ? { opaque: true as const }
          : operand(locationTarget, true);
      if (target.opaque || target.path === undefined) {
        // Where the rest of the line runs is no longer known.
        cwdLost = true;
        opaqueWord();
        if (target.path !== undefined) paths.add(target.path);
      } else {
        cwdNow = target.path;
        paths.add(target.path);
      }
    }
    if (name === 'Pop-Location') {
      cwdLost = true;
      opaqueWord();
    }

    if (opaqueText) {
      unresolvedPaths = true;
      ungrantable = true;
      exploration = false;
      commands.push(raw);
      continue;
    }
    if (opaqueProgram) {
      unresolvedPaths = true;
      exploration = false;
    }
    commands.push(values.join(' '));
    const explores =
      !writesFile &&
      !values.slice(1).some((value) => EXPLORATION_FORBIDDEN_FLAG.test(value)) &&
      (EXPLORATION_CMDLETS.has(name) || (stem === 'git' && GIT_READ_ONLY.has(values[1] ?? '')));
    exploration &&= explores;
  }

  if (commands.length === 0) exploration = false;
  return {
    paths: [...paths],
    commands,
    unresolvedPaths,
    exploration: exploration && !unresolvedPaths,
    ...(ungrantable ? { ungrantable: true } : {}),
  };
}
