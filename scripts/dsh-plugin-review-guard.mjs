/**
 * dsh-rebase E8-A (decisions 149 rule 4, 150 and 153): the three must-reject
 * items of the plugin review checklist (P1-10 shard 03 §6.2) as a static
 * guard over the third-party code the DSH host runs in its own process.
 *
 * A plugin row shares the host's process and rights (experiment E8): it can
 * pull a gateway key through `ctx.credentials`, read Main's credential answers
 * on the host's IPC channel, forge credential requests, and step out of
 * Cordis's caller tracking through `Symbol.for('cordis.original')` or a monkey
 * patch. Nothing at run time stops it, so review is the only hard line, and
 * these three findings reject a package outright:
 *
 * 1. `credentials`: it names the credentials service (`ctx.credentials`,
 *    `ctx.get('credentials')`, an `inject` of it);
 * 2. `host-ipc`: it touches the host's IPC channel (`process.send`,
 *    `process.on('message')`, `prependListener`, `removeAllListeners('message')`);
 * 3. `escape`: it reaches for `cordis.original`, or writes a property of what
 *    `ctx.get(...)` returns, of `Module`, of the global object or of `process`.
 *
 * Unlike `SENSITIVE_API_PATTERNS` in dsh-host-build-lib.mjs (a pointer for the
 * reviewer that never fails anything), a hit here fails the test that applies
 * it. There are no per-package exemptions: our own rows are not plugins and
 * are never scanned ({@link OWN_PRODUCT_ROWS}), DSH's own rows are never
 * scanned either (only what the allowlist and the product bundle mount on
 * top of dsh-base is), and a plugin that matches is rejected, not excused.
 *
 * The rules are a static approximation (decision 153 lists the edges): regular
 * expressions over the text after decoding `\u` and `\x` escapes; a match only
 * counts where it starts in code (not in a comment or inside a string), except
 * `cordis.original`, which is a string itself. A name built at run time, an
 * alias the rules do not follow, or obfuscated code passes. The guard backs
 * the review up; it does not replace reading the code.
 *
 * No dependencies beyond node:fs and node:path, so the build scripts can take
 * it in later without dragging anything along.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The product bundle's own rows (decision 150 §1): not plugins, never scanned. */
export const OWN_PRODUCT_ROWS = Object.freeze([
  'aiclient-credentials',
  'aiclient-bridge',
  'aiclient-permissions',
  'aiclient-loop-guard',
  'aiclient-encrypted-read',
]);

export const CRITERIA = Object.freeze({
  credentials: 'names the credentials service (ctx.credentials / ctx.get("credentials"))',
  'host-ipc':
    "touches the host's IPC channel (process.send / process.on('message') / prependListener / removeAllListeners('message'))",
  escape:
    'escapes Cordis tracking or monkey-patches (cordis.original, or writes a property of a ctx.get(...) result, Module, the global object or process)',
});

// ---- text: escapes and what is code -----------------------------------------

/**
 * `\uXXXX`, `\u{X}` and `\xXX` escapes that spell a letter, a digit, `_`, `$`
 * or `.`, decoded, so `process.\u006fn(...)` reads as `process.on(...)`. Other
 * escapes stay as they are: a decoded quote, slash or line break would move
 * where strings, comments and lines start and end.
 */
export function decodeEscapes(text) {
  return text.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
    (whole, braced, four, two) => {
      const code = Number.parseInt(braced ?? four ?? two, 16);
      const char = code < 0x80 ? String.fromCharCode(code) : '';
      return /^[\w$.]$/.test(char) ? char : whole;
    }
  );
}

const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * `[start, end)` ranges of `text` that are not code: comments, the inside of
 * string literals, the text parts of template literals (their `${}` stays
 * code), and regular-expression literals. A lexer's approximation (a `/`
 * after `)` is taken for division); it only narrows the rules marked `code`,
 * never the ones that judge mere appearance.
 */
export function nonCodeRanges(text) {
  const ranges = [];
  const n = text.length;
  const templates = [];
  let depth = 0;
  let last = '';
  let word = '';
  // Whitespace since the last token: `a b` is two words, not `ab`.
  let gap = false;
  let i = 0;
  const skip = (from, to) => {
    if (to > from) ranges.push([from, to]);
  };
  // From just after a backtick or a template's closing brace to its next `${` or backtick.
  const templateText = (from) => {
    let k = from;
    while (k < n) {
      if (text[k] === '\\') k += 2;
      else if (text[k] === '`') {
        skip(from, k);
        return k + 1;
      } else if (text[k] === '$' && text[k + 1] === '{') {
        skip(from, k);
        templates.push(depth);
        depth += 1;
        return k + 2;
      } else k += 1;
    }
    skip(from, n);
    return n;
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      skip(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      skip(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
      skip(i + 1, Math.min(k, n));
      i = k + 1;
      last = c;
      word = '';
    } else if (c === '`') {
      i = templateText(i + 1);
      last = '`';
      word = '';
    } else if (c === '}' && templates.length > 0 && depth - 1 === templates[templates.length - 1]) {
      templates.pop();
      depth -= 1;
      i = templateText(i + 1);
      last = '`';
      word = '';
    } else if (
      c === '/' &&
      (last === '' || '(,=:[!&|?{};~+-*%<>^'.includes(last) || REGEX_AFTER_WORD.has(word))
    ) {
      let k = i + 1;
      let inClass = false;
      while (k < n && text[k] !== '\n') {
        if (text[k] === '\\') k += 1;
        else if (text[k] === '[') inClass = true;
        else if (text[k] === ']') inClass = false;
        else if (text[k] === '/' && !inClass) break;
        k += 1;
      }
      if (k < n && text[k] === '/') {
        skip(i, k + 1);
        i = k + 1;
        last = 'a';
      } else {
        i += 1;
        last = '/';
      }
      word = '';
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      if (/[\w$]/.test(c)) {
        word = /[\w$]/.test(last) && !gap ? word + c : c;
        last = c;
        gap = false;
      } else if (/\s/.test(c)) gap = true;
      else {
        last = c;
        word = '';
        gap = false;
      }
      i += 1;
    }
  }
  return ranges;
}

/**
 * The non-code ranges of a YAML file (a bundle patch): its `#` comments only.
 * Quoted values stay code, since a `!!js` expression may be quoted.
 */
export function yamlCommentRanges(text) {
  return [...text.matchAll(/(?<=^|[ \t])#[^\n]*/gm)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

/** Whether `index` falls in one of the sorted, disjoint `ranges`. */
export function inRanges(ranges, index) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (index < start) high = mid - 1;
    else if (index >= end) low = mid + 1;
    else return true;
  }
  return false;
}

// ---- rules --------------------------------------------------------------------

const ID = '[A-Za-z_$][\\w$]*';
const QUOTE = '[\'"`]';
/** `.name`, `?.name` or `['name']` right after a receiver; `names` is an alternation. */
const member = (names) =>
  `(?:\\s*\\??\\.\\s*(?:${names})(?![\\w$])|\\s*(?:\\?\\.)?\\s*\\[\\s*${QUOTE}(?:${names})${QUOTE}\\s*\\])`;
/** One or more property steps: `.a`, `?.a`, `[expr]`. */
const CHAIN = `(?:\\s*\\??\\.\\s*${ID}|\\s*\\[[^\\]\\n]{0,200}\\])+`;
/** Any assignment operator, never a comparison or an arrow. */
const ASSIGN = '\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])';
const PROPERTY_WRITE = `${CHAIN}${ASSIGN}`;
const spec = (name) => `${QUOTE}(?:node:)?${name}${QUOTE}`;
const requireOf = (name) => `require\\s*\\(\\s*${spec(name)}\\s*\\)`;
/** `ctx.get(<anything without parentheses>)`, the receiver `ctx` or `<x>.ctx`. */
const CTX_GET = '(?<![\\w$])ctx\\s*\\.\\s*get\\s*\\(\\s*[^()]*\\)';
const DEFINERS =
  '(?<![\\w$.])(?:Object\\s*\\.\\s*(?:defineProperty|defineProperties|assign|setPrototypeOf)|Reflect\\s*\\.\\s*(?:set|defineProperty|setPrototypeOf|deleteProperty)|__defProp|__defProps)\\s*\\(\\s*';

const escapeName = (name) => name.replace(/\$/g, '\\$');
const named = (names) => names.map((name) => `(?<![\\w$.])${escapeName(name)}(?![\\w$])`);

/** Characters after a service binding in which a write through it counts (decision 153). */
export const SERVICE_ALIAS_WINDOW = 2000;

/**
 * Names a file binds to a builtin module (`module`, `events`, `process`):
 * default and namespace imports, `require(...)` (esbuild's `__toESM(require(...))`
 * included), and the named exports listed in `exports` (`{Module}`,
 * `{EventEmitter: E}`). Declarations inside comments or strings do not count.
 */
export function moduleBindings(text, ranges, moduleName, exports = []) {
  const names = new Set();
  const add = (match, name) => {
    if (name && !inRanges(ranges, match.index)) names.add(name);
  };
  const from = spec(moduleName);
  const listed = (list, separator) => {
    const out = [];
    for (const part of list.split(',')) {
      const [exported, local] = part.split(separator).map((item) => item.trim());
      if (exports.includes(exported)) out.push(local || exported);
    }
    return out;
  };
  for (const match of text.matchAll(
    new RegExp(
      `import\\s+(?:(${ID})\\s*,?\\s*)?(?:\\*\\s*as\\s+(${ID})|\\{([^}]*)\\})?\\s*from\\s*${from}`,
      'g'
    )
  )) {
    add(match, match[1]);
    add(match, match[2]);
    for (const name of listed(match[3] ?? '', /\s+as\s+/)) add(match, name);
  }
  for (const match of text.matchAll(
    new RegExp(
      `(?:const|let|var)\\s+(?:(${ID})|\\{([^}]*)\\})\\s*=\\s*[^;\\n]*?${requireOf(moduleName)}`,
      'g'
    )
  )) {
    add(match, match[1]);
    for (const name of listed(match[2] ?? '', ':')) add(match, name);
  }
  return [...names];
}

/**
 * Bindings a file makes: to `process`, to the `module` builtin and to
 * `events` (whole-file names), and to a service taken from `ctx`, each with
 * where it was made: `x = ctx.get(...)` (not called through), and in the
 * plugin's own files also `x = ctx.name`.
 */
export function collectAliases(text, ranges = nonCodeRanges(text), { own = true } = {}) {
  const process = new Set(moduleBindings(text, ranges, 'process'));
  for (const match of text.matchAll(
    new RegExp(
      `(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:(?:globalThis|global)\\s*\\.\\s*)?process\\s*(?=[;,\\n])`,
      'g'
    )
  )) {
    if (!inRanges(ranges, match.index)) process.add(match[1]);
  }
  process.delete('process');
  const sources = [`[^;\\n]*?${CTX_GET}(?=\\s*(?:[;,):}\\n]|\\?\\?|\\|\\||&&|$))`];
  if (own) sources.push(`(?:this\\s*\\.\\s*)?ctx\\s*\\??\\.\\s*${ID}\\s*(?=[;,\\n])`);
  const service = [];
  for (const match of text.matchAll(
    new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:${sources.join('|')})`, 'g')
  )) {
    if (!inRanges(ranges, match.index)) service.push({ name: match[1], index: match.index });
  }
  // A UMD wrapper's `function (global, factory)` shadows Node's `global`.
  const shadowsGlobal = [
    /(?<![\w$])function\b[\s\w$]*\(\s*(?:[\w$]+\s*,\s*)*global\s*[,)]/g,
    /\(\s*(?:[\w$]+\s*,\s*)*global\s*(?:,\s*[\w$]+\s*)*\)\s*=>/g,
    /(?<![\w$.])global\s*=>/g,
  ].some((pattern) => [...text.matchAll(pattern)].some((match) => !inRanges(ranges, match.index)));
  return {
    shadowsGlobal,
    process: [...process],
    module: moduleBindings(text, ranges, 'module', ['Module']),
    events: moduleBindings(text, ranges, 'events', ['EventEmitter']),
    service,
  };
}

/** `process`, `globalThis.process`, `global.process`, or a recorded alias of it. */
function processRef(aliases) {
  const names = ['process', ...aliases].map(escapeName).join('|');
  return `(?:(?<![\\w$.])(?:(?:globalThis|global)\\s*\\??\\.\\s*)?(?:${names})(?![\\w$]))`;
}

/**
 * The rules for one file, its whole-file aliases folded in. Each is
 * `[criterion, rule id, RegExp, mode]`: a `code` rule only counts a match that
 * starts in code ({@link nonCodeRanges}); a `raw` rule counts it anywhere.
 * `own` is false for files of the plugin's dependencies, where `ctx` is as
 * often a Koa or zod context as a Cordis one. Service aliases have
 * {@link serviceAliasRules}.
 */
export function guardRules(aliases = { process: [], module: [], events: [] }, { own = true } = {}) {
  const proc = processRef(aliases.process);
  // `process.env` is review item 5's to read by hand, not a must-reject (decision 153).
  const procNotEnv = `${proc}(?!\\s*\\??\\.\\s*env(?![\\w$])|\\s*\\[\\s*${QUOTE}env${QUOTE})`;
  const moduleRefs = [
    requireOf('module'),
    '(?<![\\w$.])module\\s*\\.\\s*constructor(?![\\w$])',
    '(?<![\\w$.])require\\s*\\.\\s*(?:cache|extensions)(?![\\w$])',
    ...named(aliases.module),
  ].join('|');
  const eventsRefs = [requireOf('events'), ...named(aliases.events)].join('|');
  const prototypeRefs = [
    '(?<![\\w$.])(?:Object|Function)\\s*\\.\\s*prototype(?![\\w$])',
    `(?:${eventsRefs})(?:\\s*\\.\\s*(?:EventEmitter|default))?\\s*\\.\\s*prototype(?![\\w$])`,
  ].join('|');
  // In the plugin's own code `ctx.<service>.<prop> = ...` is the same write as
  // through `ctx.get('<service>')`.
  const serviceRefs = own ? `${CTX_GET}|(?<![\\w$])ctx\\s*\\??\\.\\s*${ID}` : CTX_GET;
  const globalRef = aliases.shadowsGlobal
    ? '(?<![\\w$.])globalThis(?![\\w$])'
    : '(?<![\\w$.])(?:globalThis|global)(?![\\w$])';
  const targets = `(?:${procNotEnv}|${globalRef}|${moduleRefs}|${serviceRefs}|${prototypeRefs})`;
  const ctxRef = '(?<![\\w$])(?:ctx|context)';
  const message = `\\s*\\(\\s*${QUOTE}message${QUOTE}`;
  return [
    // 1. credentials: the service by property, by `get`, or in an `inject` declaration.
    [
      'credentials',
      'ctx-credentials',
      new RegExp(`${ctxRef}${member('credentials')}`, 'g'),
      'code',
    ],
    [
      'credentials',
      'ctx-get-credentials',
      new RegExp(`${ctxRef}\\s*\\??\\.\\s*get\\s*\\(\\s*${QUOTE}credentials${QUOTE}`, 'g'),
      'code',
    ],
    [
      'credentials',
      'inject-credentials',
      /(?<![\w$])inject\s*(?:[:=]\s*|\(\s*)[[{][^\]}]*?(?<![\w$])credentials(?![\w$])/g,
      'code',
    ],
    // 2. host IPC
    [
      'host-ipc',
      'message-listener',
      new RegExp(
        `${proc}${member('on|once|addListener|off|removeListener|listeners|rawListeners|emit')}${message}`,
        'g'
      ),
      'code',
    ],
    [
      'host-ipc',
      'prepend-listener',
      new RegExp(`${proc}${member('prependListener|prependOnceListener')}`, 'g'),
      'code',
    ],
    [
      'host-ipc',
      'remove-all-listeners',
      new RegExp(
        `${proc}${member('removeAllListeners')}\\s*\\(\\s*(?:\\)|${QUOTE}message${QUOTE})`,
        'g'
      ),
      'code',
    ],
    ['host-ipc', 'send', new RegExp(`${proc}${member('send')}`, 'g'), 'code'],
    // 3. escapes and monkey patches; the symbol's key is a string, so anywhere.
    ['escape', 'cordis-original', /cordis\.original/g, 'raw'],
    ['escape', 'property-write', new RegExp(`${targets}${PROPERTY_WRITE}`, 'g'), 'code'],
    ['escape', 'define-property', new RegExp(`${DEFINERS}${targets}`, 'g'), 'code'],
  ];
}

/** Writes through one service binding; applied within {@link SERVICE_ALIAS_WINDOW} of it. */
export function serviceAliasRules(name) {
  const [ref] = named([name]);
  return [
    ['escape', 'property-write', new RegExp(`${ref}${PROPERTY_WRITE}`, 'g'), 'code'],
    ['escape', 'define-property', new RegExp(`${DEFINERS}${ref}`, 'g'), 'code'],
  ];
}

function lineAndColumn(text, index) {
  let line = 1;
  let start = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    line += 1;
    start = at + 1;
  }
  return { line, column: index - start + 1 };
}

/**
 * Every hit in one file's text: `{criterion, rule, line, column, match}`, in
 * text order. `own` is false for a file of one of the plugin's dependencies;
 * `yaml` reads the text as a bundle patch rather than as JavaScript.
 */
export function scanText(raw, { own = true, yaml = false } = {}) {
  const text = decodeEscapes(raw);
  const ranges = yaml ? yamlCommentRanges(text) : nonCodeRanges(text);
  const aliases = collectAliases(text, ranges, { own });
  const hits = new Map();
  const run = (rules, from = 0, to = text.length) => {
    const part = from === 0 && to >= text.length ? text : text.slice(from, to);
    for (const [criterion, rule, pattern, mode] of rules) {
      for (const found of part.matchAll(pattern)) {
        const index = from + found.index;
        const key = `${index}:${criterion}:${rule}`;
        if (hits.has(key) || (mode === 'code' && inRanges(ranges, index))) continue;
        hits.set(key, {
          criterion,
          rule,
          index,
          ...lineAndColumn(text, index),
          match: found[0].replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
  };
  run(guardRules(aliases, { own }));
  for (const { name, index } of aliases.service) {
    run(serviceAliasRules(name), index, index + SERVICE_ALIAS_WINDOW);
  }
  return [...hits.values()].sort((a, b) => a.index - b.index).map(({ index, ...hit }) => hit);
}

// ---- files -------------------------------------------------------------------

/** Never executed by Node, or not text: skipped, and listed as skipped. */
const SKIPPED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.json',
  '.map',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.node',
  '.wasm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.tgz',
  '.br',
  '.pdf',
]);
/** Directories a package ships but never loads (its tests, docs, examples, tooling). */
const SKIPPED_DIRS = new Set([
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'spec',
  'specs',
  'bench',
  'benchmark',
  'benchmarks',
  'example',
  'examples',
  'doc',
  'docs',
  'coverage',
  '.history',
  '.yarn',
  '.github',
]);
const DECLARATION = /\.d\.[cm]?ts$/i;
const NOTICE = /^(?:licen[cs]e|copying|notice|authors)(?:[.-].*)?$/i;
const TEST_FILE = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/i;

/** The path inside its own package: what follows the last `node_modules/<name>`. */
function packageRelative(rel) {
  const parts = rel.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return parts;
  return parts.slice(at + (parts[at + 1]?.startsWith('@') ? 3 : 2));
}

/**
 * Whether the guard skips a file, given its path relative to the package (or
 * dependency) directory it was found in, with `/`. Everything else is read.
 */
export function isGuardSkipped(rel) {
  const parts = packageRelative(rel);
  const base = parts[parts.length - 1] ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  return (
    SKIPPED_EXTENSIONS.has(ext) ||
    DECLARATION.test(base) ||
    NOTICE.test(base) ||
    TEST_FILE.test(base) ||
    parts.slice(0, -1).some((dir) => SKIPPED_DIRS.has(dir.toLowerCase()))
  );
}

/**
 * Every file of a package directory and of the dependency directories it
 * brings, links followed once (by real path), split into what is scanned and
 * what is skipped. A file is the plugin's `own` when it lies in `dir` outside
 * any nested `node_modules`. Paths are relative to `base`, with `/`.
 */
export function guardFiles(dir, closure, base) {
  const scanned = [];
  const skipped = [];
  const seen = new Set();
  const visit = (full, root, own) => {
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(real).sort()) visit(path.join(full, name), root, own);
      return;
    }
    if (!stat.isFile()) return;
    const rel = path.relative(base, full).split(path.sep).join('/');
    const inside = path.relative(root, full).split(path.sep).join('/');
    const file = { rel, full: real, own: own && !inside.split('/').includes('node_modules') };
    (isGuardSkipped(inside) ? skipped : scanned).push(file);
  };
  visit(dir, dir, true);
  for (const extra of closure) visit(extra, extra, false);
  return { scanned, skipped };
}

/**
 * Scan a package and the closure it brings, byte for byte (latin1, so a NUL
 * byte hides nothing). `files` and `skipped` are relative paths; `hits` carry
 * the file they were found in.
 */
export function scanPackage({ dir, closure = [], base = dir }) {
  const { scanned, skipped } = guardFiles(dir, closure, base);
  const hits = [];
  for (const file of scanned) {
    const text = fs.readFileSync(file.full).toString('latin1');
    const yaml = /\.ya?ml$/i.test(file.rel);
    for (const hit of scanText(text, { own: file.own, yaml }))
      hits.push({ file: file.rel, ...hit });
  }
  return {
    files: scanned.map((file) => file.rel),
    skipped: skipped.map((file) => file.rel),
    hits,
  };
}

// ---- what is scanned -------------------------------------------------------------

/** The package a module specifier loads (`@s/p/sub` -> `@s/p`, `p/sub` -> `p`). */
export function packageOfSpecifier(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** `{id, name}` of every row a patch list inserts, group children included. */
export function insertedRows(patches) {
  const rows = [];
  const visit = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    rows.push({ id: row.id, name: row.name });
    if (row.group && Array.isArray(row.config)) row.config.forEach(visit);
  };
  for (const patch of patches) {
    if (patch && typeof patch === 'object' && Array.isArray(patch.insert)) {
      patch.insert.forEach(visit);
    }
  }
  return rows;
}

/**
 * The packages the guard scans, derived, never listed by hand:
 *
 * - every allowlisted plugin (`allowlist.plugins`, official or internal);
 * - every package the product bundle mounts as a row that is not one of the
 *   bundle's own modules (P1-4d3: `@deepseek-ai/dsh-tool-ask-user`, decision
 *   114, which is a plain plugin and cannot be allowlisted).
 *
 * The product bundle's own rows must be exactly {@link OWN_PRODUCT_ROWS},
 * each loading a module of `productBundle`: a new own row fails here until the
 * list (and the test's copy of it) names it. Group rows without a module are
 * containers; their children are judged one by one.
 */
export function deriveGuardTargets({ allowlist, productPatches, productBundle }) {
  const failures = [];
  const targets = new Map();
  const add = (name, source) => {
    const entry = targets.get(name) ?? { name, sources: [] };
    entry.sources.push(source);
    targets.set(name, entry);
  };
  for (const entry of allowlist.plugins) add(entry.name, 'allowlist');

  const own = [];
  for (const row of insertedRows(productPatches)) {
    if (row.name === undefined) continue;
    const label = typeof row.id === 'string' ? row.id : '(row without an id)';
    if (typeof row.name !== 'string') {
      failures.push(`product row ${label}: module name is not a literal`);
      continue;
    }
    const pkg = packageOfSpecifier(row.name);
    if (pkg === productBundle) {
      own.push(label);
      if (!OWN_PRODUCT_ROWS.includes(label)) {
        failures.push(
          `product row ${label} loads ${row.name}, a module of ${productBundle}, but is not in OWN_PRODUCT_ROWS`
        );
      }
    } else {
      if (OWN_PRODUCT_ROWS.includes(label)) {
        failures.push(`product row ${label} is listed as our own but loads ${row.name}`);
      }
      add(pkg, `product row ${label}`);
    }
  }
  for (const row of OWN_PRODUCT_ROWS) {
    if (!own.includes(row))
      failures.push(`OWN_PRODUCT_ROWS names ${row}, which the product bundle does not insert`);
  }
  return { targets: [...targets.values()], own, failures };
}

/** One line per hit, for a failure message. */
export function formatHits(name, version, hits) {
  return hits.map(
    (hit) =>
      `${name}@${version}: ${hit.file}:${hit.line}:${hit.column} [${hit.criterion}/${hit.rule}] ${hit.match}`
  );
}
