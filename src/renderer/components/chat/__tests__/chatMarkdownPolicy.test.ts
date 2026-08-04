import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_CODE_FONT_STYLE,
  CHAT_CODE_LANGUAGES,
  CHAT_HIGHLIGHT_MAX_CHARS,
  CHAT_HIGHLIGHT_MAX_LINE_CHARS,
  CHAT_HIGHLIGHT_MAX_LINES,
  CHAT_MARKDOWN_ALLOWED_PROTOCOLS,
  CHAT_MARKDOWN_POLICY,
  chatCodeTokenStyle,
  chatMarkdownBlockquoteClass,
  chatMarkdownCodeBlockClass,
  chatMarkdownFootnotesClass,
  chatMarkdownHeadingClass,
  chatMarkdownHrClass,
  chatMarkdownImagePlaceholderClass,
  chatMarkdownLinkClass,
  chatMarkdownListClass,
  chatMarkdownParagraphClass,
  chatMarkdownRootClass,
  chatMarkdownTableCellClass,
  chatMarkdownTableWrapClass,
  chatMarkdownUrlTransform,
  codeLanguageFromClassName,
  deriveStreamingBlockIds,
  isFencedCodeBlock,
  normalizeCodeLanguage,
  type StreamingGateMessage,
  sanitizeMarkdownHref,
  shouldHighlightFence,
  shouldRenderMarkdown,
} from '../chatMarkdownPolicy';
import { chatTurnClass, turnBodyClass, turnBubbleBandClass } from '../chatTimelineLayout';
import { readDarkClass } from '../useDarkClass';
import { stripComments } from './stripComments';

/**
 * T-29 (execution plan §3 T-29 row, D26 option 1): the assistant-prose Markdown
 * layer, F-C1 … F-C7.
 *
 * The suite has two halves and they assert different KINDS of thing:
 *
 *  - F-C1 … F-C4 and F-C7 are ordinary truth tables and class assertions over
 *    pure functions;
 *  - F-C5 is the security posture, and a policy OBJECT can only ever assert
 *    that someone typed the object. So it is paired with a static scan of the
 *    files that do the rendering, which is what actually forbids `rehype-raw`,
 *    `dangerouslySetInnerHTML` and any `src`-bearing element. Neither half is
 *    sufficient alone; both are cheap.
 *
 * A static scan has one failure mode worth naming here, because this file spent
 * a review cycle inside it: it can stop seeing the code it scans and keep
 * passing. Every negative assertion below is therefore paired with a POSITIVE
 * control — the same matcher, run against a fixture that plants the forbidden
 * construct in code, so "this file has no `<img>`" and "this matcher can find an
 * `<img>`" are two different assertions and both have to hold.
 */

// ---------------------------------------------------------------------------
// F-C1: href sanitisation
// ---------------------------------------------------------------------------

describe('F-C1: sanitizeMarkdownHref', () => {
  it('F-C1: accepts absolute http(s) and returns the RE-SERIALISED url', () => {
    expect(sanitizeMarkdownHref('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(sanitizeMarkdownHref('http://example.com')).toBe('http://example.com/');
    // What is returned is what `shell.openExternal` receives, and the preload
    // does not re-check it — so the returned value must be the PARSED one, not
    // the author's string. Case and host normalisation prove it went through
    // the parser rather than a prefix test.
    expect(sanitizeMarkdownHref('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('F-C1: rejects every non-http(s) scheme', () => {
    for (const href of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:https://example.com/abc',
      'mailto:a@b.com',
      'about:blank',
      'chrome://settings',
      'ms-msdt:/id',
      'vscode://file/etc/passwd',
    ]) {
      expect(sanitizeMarkdownHref(href), href).toBeNull();
    }
  });

  it('F-C1: scheme case mixing does not smuggle javascript:', () => {
    for (const href of ['JavaScript:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)']) {
      expect(sanitizeMarkdownHref(href), href).toBeNull();
    }
  });

  it('F-C1: whitespace and control-character injection does not smuggle javascript:', () => {
    // Every one of these is parsed as `javascript:` by the WHATWG URL parser
    // (tab/CR/LF are removed from the input, leading C0/space is trimmed) and
    // therefore by the browser — a prefix test on the raw string would pass
    // them all.
    for (const href of [
      ' javascript:alert(1)',
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      '\u0000javascript:alert(1)',
      'javascript\n:alert(1)',
    ]) {
      expect(sanitizeMarkdownHref(href), JSON.stringify(href)).toBeNull();
    }
  });

  it('F-C1: rejects relative and protocol-relative references', () => {
    for (const href of [
      '/etc/passwd',
      './notes.md',
      '../../secret',
      'notes.md',
      '//evil.example/x',
      '#anchor',
      '?q=1',
      'C:\\Windows\\system32',
      '\\\\server\\share',
    ]) {
      expect(sanitizeMarkdownHref(href), href).toBeNull();
    }
  });

  it('F-C1: rejects empty and non-string input', () => {
    expect(sanitizeMarkdownHref('')).toBeNull();
    expect(sanitizeMarkdownHref('   ')).toBeNull();
    expect(sanitizeMarkdownHref(null)).toBeNull();
    expect(sanitizeMarkdownHref(undefined)).toBeNull();
    // A scheme with no host is not a usable http url and must not become one.
    expect(sanitizeMarkdownHref('https://')).toBeNull();
    expect(sanitizeMarkdownHref('http://')).toBeNull();
  });

  it('F-C1: the allow-list is exactly http + https', () => {
    expect([...CHAT_MARKDOWN_ALLOWED_PROTOCOLS]).toEqual(['http:', 'https:']);
  });

  it("F-C1: react-markdown's urlTransform gate agrees with the component gate", () => {
    expect(chatMarkdownUrlTransform('https://example.com/')).toBe('https://example.com/');
    expect(chatMarkdownUrlTransform('javascript:alert(1)')).toBe('');
    expect(chatMarkdownUrlTransform('./relative')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// F-C2: fenced-code language handling
// ---------------------------------------------------------------------------

describe('F-C2: normalizeCodeLanguage', () => {
  it('F-C2: canonical ids pass through', () => {
    for (const language of CHAT_CODE_LANGUAGES) {
      expect(normalizeCodeLanguage(language), language).toBe(language);
    }
  });

  it('F-C2: the aliases models actually emit resolve to a canonical id', () => {
    const expected: Record<string, string> = {
      js: 'javascript',
      JS: 'javascript',
      ts: 'typescript',
      TSX: 'tsx',
      py: 'python',
      rb: 'ruby',
      rs: 'rust',
      sh: 'shell',
      zsh: 'shell',
      console: 'shell',
      shellscript: 'shell',
      yml: 'yaml',
      md: 'markdown',
      'c++': 'cpp',
      'c#': 'csharp',
      cs: 'csharp',
      golang: 'go',
      jsonc: 'json',
      patch: 'diff',
    };
    for (const [raw, canonical] of Object.entries(expected)) {
      expect(normalizeCodeLanguage(raw), raw).toBe(canonical);
    }
  });

  it('F-C2: only the first word of the info string names the grammar', () => {
    expect(normalizeCodeLanguage('ts twoslash')).toBe('typescript');
    expect(normalizeCodeLanguage('js {1,3-4}')).toBe('javascript');
    expect(normalizeCodeLanguage('  python  ')).toBe('python');
    expect(normalizeCodeLanguage('ts,twoslash')).toBe('typescript');
  });

  // The Docusaurus filename form (```ts:src/index.ts) is copied out of
  // documentation corpora often enough that models emit it unprompted, and
  // before the colon joined the delimiter set the whole string missed the alias
  // table and the fence rendered un-highlighted.
  it('F-C2: the ```lang:path filename form still names the grammar', () => {
    expect(normalizeCodeLanguage('ts:src/index.ts')).toBe('typescript');
    expect(normalizeCodeLanguage('js:app.js')).toBe('javascript');
    expect(normalizeCodeLanguage('TS:src/index.ts')).toBe('typescript');
    expect(normalizeCodeLanguage('python:main.py')).toBe('python');
    // …and the colon does not invent a language out of an unknown prefix.
    expect(normalizeCodeLanguage('brainfuck:a.bf')).toBeNull();
    expect(normalizeCodeLanguage(':src/index.ts')).toBeNull();
  });

  // The info string is model-authored and reaches a plain object literal. A bare
  // index answers `__proto__` with `Object.prototype` and `constructor` with
  // `Object` — both non-null, so `?? null` does not fire and a NON-STRING
  // escapes as a `ChatCodeLanguage`, past `highlightChatCode`'s `if (!language)`
  // fast path and into a full shiki singleton build for a fence that can never
  // be highlighted. `toBeNull` is the assertion because it fails on any of them.
  it('F-C2: an inherited Object property is not a language', () => {
    for (const raw of [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'prototype',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__ twoslash',
      '__proto__:src/index.ts',
      'CONSTRUCTOR',
    ]) {
      expect(normalizeCodeLanguage(raw), raw).toBeNull();
    }
  });

  // Same guard, stated as the property that actually matters: whatever comes
  // back is a string this module promised to support, or nothing at all. A
  // function or an object escaping here is the failure mode above.
  it('F-C2: the return value is always a supported id or null, for any input', () => {
    const supported: readonly string[] = CHAT_CODE_LANGUAGES;
    for (const raw of [
      '__proto__',
      'constructor',
      'valueOf',
      'ts',
      'ts:src/index.ts',
      'brainfuck',
      '',
      '   ',
      'c++',
    ]) {
      const language = normalizeCodeLanguage(raw);
      if (language === null) continue;
      expect(typeof language, raw).toBe('string');
      expect(supported, raw).toContain(language);
    }
  });

  it('F-C2: an unknown or absent language is null, never a guess', () => {
    for (const raw of ['', '   ', 'brainfuck', 'text', 'plaintext', 'mermaid', null, undefined]) {
      expect(normalizeCodeLanguage(raw), String(raw)).toBeNull();
    }
  });

  it('F-C2: every canonical id is unique (an alias table typo would collapse two)', () => {
    expect(new Set(CHAT_CODE_LANGUAGES).size).toBe(CHAT_CODE_LANGUAGES.length);
  });

  it('F-C2: the language is read out of react-markdown\u2019s language-* class', () => {
    expect(codeLanguageFromClassName('language-ts')).toBe('ts');
    expect(codeLanguageFromClassName('foo language-python bar')).toBe('python');
    expect(codeLanguageFromClassName('nolang')).toBeNull();
    expect(codeLanguageFromClassName(undefined)).toBeNull();
  });

  it('F-C2: block vs inline is decided by the language class OR a newline', () => {
    expect(isFencedCodeBlock({ className: 'language-ts', text: 'const a = 1' })).toBe(true);
    expect(isFencedCodeBlock({ className: undefined, text: 'line1\nline2' })).toBe(true);
    expect(isFencedCodeBlock({ className: undefined, text: 'inline' })).toBe(false);
    expect(isFencedCodeBlock({ className: 'not-a-language', text: 'inline' })).toBe(false);
    // The class is found among others, which is the shape `remark-gfm` produces.
    expect(isFencedCodeBlock({ className: 'contains-task-list language-python', text: 'x' })).toBe(
      true
    );
    // `language-` with no id is not a language class, so this falls through to
    // the other two clauses and stays inline.
    expect(isFencedCodeBlock({ className: 'language-', text: 'inline' })).toBe(false);
  });

  // The third clause. A fence opened with no info string and no body
  // (```\n```) has neither a `language-*` class nor a newline, and
  // `react-markdown` hands the renderer `children === undefined` — where an
  // inline span always has a non-empty string. Without it the empty fence
  // rendered as an empty `CodeInline` chip: a stray 8px grey pill in the prose.
  it('F-C2: a fence with no children at all is a block, and only that case is', () => {
    expect(isFencedCodeBlock({ className: undefined, text: '', hasChildren: false })).toBe(true);
    expect(isFencedCodeBlock({ className: null, text: '', hasChildren: false })).toBe(true);
    // Inline code has children, so the clause must not fire for it.
    expect(isFencedCodeBlock({ className: undefined, text: 'inline', hasChildren: true })).toBe(
      false
    );
    // …and the clause keys off an explicit `false`, not off "falsy or absent":
    // an omitted flag is a caller that does not know, and the safe reading of
    // "don't know" is the one that keeps a lone empty string inline.
    expect(isFencedCodeBlock({ className: undefined, text: '' })).toBe(false);
    expect(isFencedCodeBlock({ className: undefined, text: '', hasChildren: undefined })).toBe(
      false
    );
    // The other two clauses still win over it.
    expect(isFencedCodeBlock({ className: 'language-ts', text: 'x', hasChildren: true })).toBe(
      true
    );
    expect(isFencedCodeBlock({ className: undefined, text: 'a\nb', hasChildren: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-C3: the streaming gate
// ---------------------------------------------------------------------------

describe('F-C3: shouldRenderMarkdown', () => {
  it('F-C3: the block still streaming stays plain text', () => {
    expect(shouldRenderMarkdown({ blockId: 'b3', streamingBlockId: 'b3' })).toBe(false);
  });

  it('F-C3: a completed block renders markdown', () => {
    expect(shouldRenderMarkdown({ blockId: 'b1', streamingBlockId: 'b3' })).toBe(true);
  });

  it('F-C3: an idle turn (no streaming block at all) renders markdown', () => {
    expect(shouldRenderMarkdown({ blockId: 'b3', streamingBlockId: null })).toBe(true);
  });

  it('F-C3: restored history (h:-prefixed ids) is treated as completed', () => {
    // A replayed transcript is never the active turn, so `MessageTimeline`
    // hands every one of its items `streamingBlockId: null`.
    expect(shouldRenderMarkdown({ blockId: 'h:msg-1:block-0', streamingBlockId: null })).toBe(true);
    expect(shouldRenderMarkdown({ blockId: 'h:msg-9:block-4', streamingBlockId: null })).toBe(true);
  });

  it('F-C3: the gate is by IDENTITY, so a same-text block elsewhere is unaffected', () => {
    expect(shouldRenderMarkdown({ blockId: 'b3', streamingBlockId: 'b3 ' })).toBe(true);
    expect(shouldRenderMarkdown({ blockId: '', streamingBlockId: null })).toBe(true);
  });
});

/**
 * F-C3, the other half: WHICH block the gate is handed.
 *
 * This derivation used to be an inline `useMemo` in `MessageTimeline.tsx`, i.e.
 * in the one place the node-only suite cannot see, and two defects lived in that
 * blind spot until the T-29 review — a session-wide flag that dropped every
 * earlier answer back to plain text whenever a new turn started, and a
 * non-monotonic predicate that flipped Markdown on and off around every
 * authorization round-trip. Both are shape errors in this table, not in
 * `shouldRenderMarkdown`, which is why the table is here rather than in a
 * component test.
 */
describe('F-C3: deriveStreamingBlockIds', () => {
  const message = (over: Partial<StreamingGateMessage> = {}): StreamingGateMessage => ({
    id: 'm1',
    lastBlockId: 'b-last',
    tracked: true,
    completed: false,
    ...over,
  });

  const streamingIdFor = (turnInFlight: boolean, over: Partial<StreamingGateMessage> = {}) =>
    deriveStreamingBlockIds({ messages: [message(over)], turnInFlight }).get('m1');

  // The whole truth table, spelled out rather than generated: three booleans is
  // eight rows, and exactly one of them may name a block.
  it('F-C3: a block is in flight iff turnInFlight AND tracked AND NOT completed', () => {
    const rows: ReadonlyArray<{
      turnInFlight: boolean;
      tracked: boolean;
      completed: boolean;
      expected: string | null;
    }> = [
      { turnInFlight: true, tracked: true, completed: false, expected: 'b-last' },
      { turnInFlight: true, tracked: true, completed: true, expected: null },
      { turnInFlight: true, tracked: false, completed: false, expected: null },
      { turnInFlight: true, tracked: false, completed: true, expected: null },
      { turnInFlight: false, tracked: true, completed: false, expected: null },
      { turnInFlight: false, tracked: true, completed: true, expected: null },
      { turnInFlight: false, tracked: false, completed: false, expected: null },
      { turnInFlight: false, tracked: false, completed: true, expected: null },
    ];
    for (const { turnInFlight, tracked, completed, expected } of rows) {
      const label = `turnInFlight=${turnInFlight} tracked=${tracked} completed=${completed}`;
      expect(streamingIdFor(turnInFlight, { tracked, completed }), label).toBe(expected);
    }
    // Exactly one row may be non-null, or the gate has widened.
    const nonNull = rows.filter((row) => row.expected !== null);
    expect(nonNull).toHaveLength(1);
  });

  /**
   * The regression nail for "a new turn starts and the whole session's answers
   * fall back to plain text".
   *
   * Restored (`h:`-prefixed) history has no metadata at all, so `tracked` is
   * false — and the bug was that the caller's session-wide flag was the ONLY
   * input, which made every one of those messages report its last block as
   * streaming for as long as the new reply took. Headings, lists, tables and
   * code boxes disappeared from the scrollback, then all snapped back at once.
   */
  it('F-C3: restored history is never streaming, even while a turn is in flight', () => {
    expect(streamingIdFor(true, { id: 'm1', tracked: false, completed: false })).toBeNull();
    const restored = deriveStreamingBlockIds({
      turnInFlight: true,
      messages: [
        { id: 'h:msg-1', lastBlockId: 'h:msg-1:block-0', tracked: false, completed: false },
        { id: 'h:msg-2', lastBlockId: 'h:msg-2:block-3', tracked: false, completed: false },
      ],
    });
    expect([...restored.values()]).toEqual([null, null]);
  });

  // `completedAt` only ever goes from unset to set, so this direction is the
  // monotonicity the gate depends on: once a message reports completed, no later
  // state of the same turn can put it back in flight.
  it('F-C3: a message that completes mid-turn converts while the turn is still in flight', () => {
    const messages = [
      { id: 'earlier', lastBlockId: 'e-2', tracked: true, completed: true },
      { id: 'current', lastBlockId: 'c-0', tracked: true, completed: false },
    ];
    const map = deriveStreamingBlockIds({ messages, turnInFlight: true });
    expect(map.get('earlier')).toBeNull();
    expect(map.get('current')).toBe('c-0');
  });

  // The abort path: a cancelled turn may never receive a `completedAt`, so the
  // release comes from `turnInFlight` going false rather than from the message.
  it('F-C3: an aborted turn is released by turnInFlight alone', () => {
    const messages = [{ id: 'aborted', lastBlockId: 'a-0', tracked: true, completed: false }];
    expect(deriveStreamingBlockIds({ messages, turnInFlight: true }).get('aborted')).toBe('a-0');
    expect(deriveStreamingBlockIds({ messages, turnInFlight: false }).get('aborted')).toBeNull();
  });

  // An assistant message whose blocks have not arrived yet: there is no last
  // block to name, and `null` here means the same thing it means everywhere else
  // in the map — "no block of this message is gated".
  it('F-C3: a message with no blocks yields null rather than undefined', () => {
    const map = deriveStreamingBlockIds({
      messages: [{ id: 'empty', lastBlockId: null, tracked: true, completed: false }],
      turnInFlight: true,
    });
    expect(map.get('empty')).toBeNull();
    expect(map.has('empty')).toBe(true);
  });

  it('F-C3: every message gets exactly one entry, keyed by its own id', () => {
    const messages = [
      { id: 'a', lastBlockId: 'a-1', tracked: true, completed: true },
      { id: 'b', lastBlockId: 'b-1', tracked: false, completed: false },
      { id: 'c', lastBlockId: 'c-1', tracked: true, completed: false },
    ];
    const map = deriveStreamingBlockIds({ messages, turnInFlight: true });
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
    // Only the one message that is tracked-and-unfinished names a block, and it
    // names its OWN last block — a mixed turn is the case the session-wide flag
    // got wrong.
    expect([...map.values()]).toEqual([null, null, 'c-1']);
    // `MessageTimeline` reads this map with `?? null`, so an id that is not in
    // it must be indistinguishable from one that maps to null.
    expect(map.get('not-a-message') ?? null).toBeNull();
  });

  it('F-C3: no messages is an empty map, not a throw', () => {
    expect(deriveStreamingBlockIds({ messages: [], turnInFlight: true }).size).toBe(0);
    expect(deriveStreamingBlockIds({ messages: [], turnInFlight: false }).size).toBe(0);
  });

  // The two halves of F-C3 meet here: what the derivation produces is what the
  // gate consumes, so the end-to-end answer for restored history is "render
  // Markdown" even though a turn is in flight.
  it('F-C3: derivation and gate compose to the behaviour the ARD ruling states', () => {
    const messages = [
      { id: 'h:msg-1', lastBlockId: 'h:msg-1:block-0', tracked: false, completed: false },
      { id: 'live', lastBlockId: 'live-2', tracked: true, completed: false },
    ];
    const map = deriveStreamingBlockIds({ messages, turnInFlight: true });
    const gate = (messageId: string, blockId: string) =>
      shouldRenderMarkdown({ blockId, streamingBlockId: map.get(messageId) ?? null });
    expect(gate('h:msg-1', 'h:msg-1:block-0')).toBe(true);
    expect(gate('live', 'live-1')).toBe(true);
    expect(gate('live', 'live-2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-C4: class assembly
// ---------------------------------------------------------------------------

/** Tailwind's spacing scale: one step is 4px (`mt-2.5` -> 10px). */
const SPACING_STEP_PX = 4;

function marginTopPx(classes: string): number {
  const match = /(?:^|\s)mt-([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(classes);
  if (!match) throw new Error(`no \`mt-*\` utility in: ${classes}`);
  return Number(match[1]) * SPACING_STEP_PX;
}

/** Every font-size token registered in `lib/utils.ts`'s tailwind-merge group, plus tailwind's own tiers. */
const FONT_SIZE_TOKENS = [
  'text-2xs',
  'text-code',
  'text-meta',
  'text-ui',
  'text-markdown',
  'text-title',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
] as const;

function fontSizeTokensIn(classes: string): string[] {
  return classes
    .split(/\s+/)
    .map((token) => token.slice(token.lastIndexOf(':') + 1))
    .filter((token) => (FONT_SIZE_TOKENS as readonly string[]).includes(token));
}

const ALL_BLOCK_CLASSES: ReadonlyArray<{ name: string; cls: string }> = [
  { name: 'paragraph', cls: chatMarkdownParagraphClass() },
  { name: 'h1', cls: chatMarkdownHeadingClass(1) },
  { name: 'h2', cls: chatMarkdownHeadingClass(2) },
  { name: 'h3', cls: chatMarkdownHeadingClass(3) },
  { name: 'h4', cls: chatMarkdownHeadingClass(4) },
  { name: 'h5', cls: chatMarkdownHeadingClass(5) },
  { name: 'h6', cls: chatMarkdownHeadingClass(6) },
  { name: 'ul', cls: chatMarkdownListClass(false) },
  { name: 'ol', cls: chatMarkdownListClass(true) },
  { name: 'code block', cls: chatMarkdownCodeBlockClass() },
  { name: 'table wrap', cls: chatMarkdownTableWrapClass() },
  { name: 'blockquote', cls: chatMarkdownBlockquoteClass() },
  { name: 'hr', cls: chatMarkdownHrClass() },
  { name: 'footnotes', cls: chatMarkdownFootnotesClass('footnotes') },
];

describe('F-C4: the markdown root cannot break the pinned bubble (sticky chain)', () => {
  // T-31's user bubble is a plain `position: sticky` scoped by the turn
  // `<section>`. Each of these four properties either turns sticky off or
  // re-parents its containing block, and the failure is invisible in review —
  // the bubble simply stops pinning. The prohibition is asserted, not commented,
  // for the same reason F-B8/F-B10 assert it on the band and the section.
  it('F-C4: the root carries no overflow / transform / filter / contain', () => {
    const cls = chatMarkdownRootClass();
    expect(cls).not.toMatch(/overflow-/);
    expect(cls).not.toMatch(/transform/);
    expect(cls).not.toMatch(/filter/);
    expect(cls).not.toMatch(/(?:^|\s)contain-/);
  });

  // The premise of the assertion above: these are the two elements the root
  // sits inside, and both are still clean. If either grew an overflow, the root
  // being clean would stop meaning anything.
  it('F-C4: the containing-block constraint T-31 landed is still in force', () => {
    for (const cls of [chatTurnClass(), turnBubbleBandClass()]) {
      expect(cls).not.toMatch(/overflow-/);
      expect(cls).not.toMatch(/transform/);
      expect(cls).not.toMatch(/(?:^|\s)contain-/);
    }
  });

  // …and the horizontal scroll that a wide code block / table genuinely needs
  // is therefore pushed down to those two LEAF surfaces, which are inside the
  // answer body and on nobody's sticky chain.
  it('F-C4: horizontal scrolling lives on the code and table leaves only', () => {
    expect(chatMarkdownCodeBlockClass()).toContain('overflow-x-auto');
    expect(chatMarkdownTableWrapClass()).toContain('overflow-x-auto');
    for (const { name, cls } of ALL_BLOCK_CLASSES) {
      if (name === 'code block' || name === 'table wrap') continue;
      expect(cls, name).not.toMatch(/overflow-/);
    }
  });

  it('F-C4: the root is body copy and drops the plain-text renderer\u2019s pre-wrap', () => {
    const cls = chatMarkdownRootClass();
    expect(cls).toContain('text-markdown');
    expect(cls).toContain('leading-normal');
    expect(cls).toContain('break-words');
    // `globals.css` disables `user-select` on `*`; `.select-text` is the only
    // way back in. Dropping it makes the prose un-selectable (T-29 GUI review).
    expect(cls).toContain('select-text');
    // `remark-breaks` turns a single newline into a `<br>`; keeping pre-wrap on
    // top of it would double every blank line.
    expect(cls).not.toContain('whitespace-pre-wrap');
  });
});

describe('F-C4: heading rank is carried by weight + colour + section gap, never by size (D25)', () => {
  it('F-C4: every heading level is --text-markdown and carries no other size token', () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const cls = chatMarkdownHeadingClass(level);
      expect(fontSizeTokensIn(cls), `h${level}`).toEqual(['text-markdown']);
      // An arbitrary size value would dodge the token list entirely.
      expect(cls, `h${level}`).not.toMatch(/text-\[/);
    }
  });

  it('F-C4: no heading carries a tracking utility (D25: <18px must be non-negative)', () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      expect(chatMarkdownHeadingClass(level), `h${level}`).not.toMatch(/tracking-/);
    }
  });

  it('F-C4: the three ranks are actually distinguishable from one another', () => {
    const ranks = [
      chatMarkdownHeadingClass(1),
      chatMarkdownHeadingClass(4),
      chatMarkdownHeadingClass(6),
    ];
    expect(new Set(ranks).size).toBe(3);
    // D25 hard constraint 1: 500 must never be the sole carrier of a level
    // distinction (Win10's Segoe UI has no 500 and falls DOWN to 400), so the
    // ranks are drawn from 400/600 only.
    for (const cls of ranks) {
      expect(cls).not.toContain('font-medium');
      expect(cls).toMatch(/font-(?:normal|semibold)/);
    }
  });

  it('F-C4: h1-h3 open a section (20px), h4-h6 sit on the block beat (10px)', () => {
    for (const level of [1, 2, 3] as const) {
      expect(marginTopPx(chatMarkdownHeadingClass(level)), `h${level}`).toBe(20);
    }
    for (const level of [4, 5, 6] as const) {
      expect(marginTopPx(chatMarkdownHeadingClass(level)), `h${level}`).toBe(10);
    }
  });
});

describe('F-C4: block rhythm reuses the turn layout\u2019s two tiers, inventing none', () => {
  it('F-C4: every block gap is either the 10px within-turn tier or the 20px section tier', () => {
    for (const { name, cls } of ALL_BLOCK_CLASSES) {
      expect([10, 20], `${name}: ${cls}`).toContain(marginTopPx(cls));
    }
  });

  // The 10px tier is not a number picked here — it is `turnBodyClass()`'s own
  // gap (P-17), so the two move together or this fails.
  it('F-C4: the 10px tier is literally the turn body gap', () => {
    const bodyGap = /(?:^|\s)gap-([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(turnBodyClass());
    expect(bodyGap).not.toBeNull();
    expect(Number(bodyGap?.[1]) * SPACING_STEP_PX).toBe(10);
    expect(marginTopPx(chatMarkdownParagraphClass())).toBe(10);
  });

  it('F-C4: every block neutralises its own leading gap when it is first', () => {
    for (const { name, cls } of ALL_BLOCK_CLASSES) {
      expect(cls, name).toContain('first:mt-0');
    }
  });
});

describe('F-C4: the mono domain', () => {
  // D25 §2.4: 13px mono is the optical-compensation tier against 15px sans body
  // copy. The code block must be on it and must NOT re-declare the body tier.
  it('F-C4: the fenced code block is --text-code, not body copy', () => {
    expect(fontSizeTokensIn(chatMarkdownCodeBlockClass())).toEqual(['text-code']);
  });

  // D25 §3.3: mono + non-zero tracking breaks column alignment, and the repo's
  // A5 scan only sees the two written into the SAME class string. Writing no
  // tracking at all is the strongest form of compliance.
  it('F-C4: no markdown class pairs a tracking utility with the code tier', () => {
    for (const { name, cls } of ALL_BLOCK_CLASSES) {
      expect(cls, name).not.toMatch(/tracking-(?!normal\b)/);
    }
  });

  // The whole reason this feature adds no entry to the A1 `font-mono`
  // whitelist: `<pre>`/`<code>` are mono from Tailwind preflight, and inline
  // code goes through `ui/ident.tsx`'s `CodeInline` primitive.
  it('F-C4: no class in this module spells font-mono', () => {
    for (const { name, cls } of ALL_BLOCK_CLASSES) {
      expect(cls, name).not.toContain('font-mono');
    }
    expect(chatMarkdownRootClass()).not.toContain('font-mono');
  });

  it('F-C4: a highlighted token becomes colour + italic/bold and nothing else', () => {
    expect(chatCodeTokenStyle({ content: 'x', color: '#393a34' })).toEqual({ color: '#393a34' });
    expect(
      chatCodeTokenStyle({ content: 'x', color: '#a0a', fontStyle: CHAT_CODE_FONT_STYLE.italic })
    ).toEqual({ color: '#a0a', fontStyle: 'italic' });
    expect(chatCodeTokenStyle({ content: 'x', fontStyle: CHAT_CODE_FONT_STYLE.bold })).toEqual({
      fontWeight: 'bold',
    });
    // Combined bits, and the two D25 forbids on mono are dropped rather than
    // mapped (underline / strikethrough).
    expect(
      chatCodeTokenStyle({
        content: 'x',
        fontStyle:
          CHAT_CODE_FONT_STYLE.italic |
          CHAT_CODE_FONT_STYLE.bold |
          CHAT_CODE_FONT_STYLE.underline |
          CHAT_CODE_FONT_STYLE.strikethrough,
      })
    ).toEqual({ fontStyle: 'italic', fontWeight: 'bold' });
    // No token at all must not emit an empty `color`, which React would set.
    expect(chatCodeTokenStyle({ content: 'x' })).toEqual({});
  });
});

describe('F-C4: the remaining surfaces', () => {
  it('F-C4: links are visibly links', () => {
    const cls = chatMarkdownLinkClass();
    expect(cls).toContain('text-primary');
    expect(cls).toContain('underline');
  });

  // D25 / WCAG AA: `text-primary` measures 4.73:1 on light and 5.49:1 on dark,
  // and the `hover:text-primary/80` this class used to carry took that to
  // 3.39:1 / 3.93:1 — under the 4.5:1 floor for body text in BOTH themes. The
  // hover affordance therefore moves the decoration, which is not text
  // contrast. Asserted as "no hover-time text colour at all" rather than as
  // "not that one literal", because `/70` would be worse and would pass a
  // literal check.
  it('F-C4: hover feedback moves the underline, never the text colour', () => {
    const cls = chatMarkdownLinkClass();
    expect(cls).not.toContain('hover:text-primary/80');
    expect(cls).not.toMatch(/hover:text-/);
    // …and no alpha on the resting text colour either, which would fail the
    // same contrast floor without a hover involved.
    expect(cls).not.toMatch(/(?:^|\s)text-primary\/\d/);
    // The affordance that replaced it. Alpha on the DECORATION is fine: it is
    // not text, so the 4.5:1 floor does not apply to it.
    expect(cls).toContain('decoration-primary/40');
    expect(cls).toContain('hover:decoration-primary');
    expect(cls).toContain('underline-offset-4');
  });

  it('F-C4: lists indent and re-tighten their nested levels', () => {
    for (const ordered of [false, true]) {
      const cls = chatMarkdownListClass(ordered);
      expect(cls).toContain(ordered ? 'list-decimal' : 'list-disc');
      expect(cls).toContain('ml-5');
      // Without these a sublist inherits the 10px block gap and a three-level
      // outline reads as three separate paragraphs.
      expect(cls).toContain('[&_ul]:mt-1');
      expect(cls).toContain('[&_ol]:mt-1');
    }
  });

  it('F-C4: table cells share one border and one padding', () => {
    expect(chatMarkdownTableCellClass('head')).toContain('font-semibold');
    expect(chatMarkdownTableCellClass('body')).not.toContain('font-semibold');
    for (const kind of ['head', 'body'] as const) {
      expect(chatMarkdownTableCellClass(kind)).toContain('border-border');
    }
  });

  // `remark-gfm` marks task items `.task-list-item` and the checkbox IS the
  // marker; without this a `- [ ] item` renders a bullet AND a checkbox. Scoped
  // to the marked `<li>` so a mixed list keeps bullets on its prose items.
  it('F-C4: a GFM task item drops its bullet, and only the task item does', () => {
    for (const ordered of [false, true]) {
      expect(chatMarkdownListClass(ordered)).toContain('[&_li.task-list-item]:list-none');
      // Not applied to the list as a whole, which would strip every marker.
      expect(chatMarkdownListClass(ordered)).not.toMatch(/(?:^|\s)list-none(?:\s|$)/);
    }
  });

  // The footnote apparatus is separated from the answer by the 20px SECTION
  // tier, and the rule is keyed off `remark-gfm`'s own class so no other
  // `<section>` can inherit it.
  it('F-C4: the footnote block separates on the section tier, and nothing else does', () => {
    const footnotes = chatMarkdownFootnotesClass('footnotes');
    expect(marginTopPx(footnotes)).toBe(20);
    expect(footnotes).toContain('text-muted-foreground');
    // Any other section — including one whose class merely CONTAINS the word —
    // gets nothing.
    for (const other of ['', 'prose', 'my-footnotes', 'footnotes-extra', null, undefined]) {
      expect(chatMarkdownFootnotesClass(other), JSON.stringify(other)).toBe('');
    }
    // …and it is found among several classes, not only when it stands alone.
    expect(chatMarkdownFootnotesClass('data-footnotes footnotes')).toBe(footnotes);
  });

  // The placeholder must not be able to become a picture by CSS either.
  it('F-C4: the image placeholder is a chip, with nothing that can fetch', () => {
    const cls = chatMarkdownImagePlaceholderClass();
    expect(cls).toContain('text-meta');
    expect(cls).not.toMatch(/bg-\[url/);
    expect(cls).not.toContain('bg-cover');
  });
});

// ---------------------------------------------------------------------------
// F-C7: the highlight budget
// ---------------------------------------------------------------------------

/**
 * A body of `lines` lines with no trailing newline — the shape the renderer
 * actually passes, since `ChatMarkdown`'s `code` branch strips the fence's
 * final `\n` before handing the text to `ChatCodeBlock`.
 */
function bodyOfLines(lines: number, lineLength = 4): string {
  return Array.from({ length: lines }, () => 'x'.repeat(lineLength)).join('\n');
}

/** A body of exactly `chars` characters, wrapped so neither other budget is near its limit. */
function bodyOfChars(chars: number): string {
  const line = `${'x'.repeat(100)}\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

describe('F-C7: shouldHighlightFence', () => {
  // The three numbers are load-bearing measurements, not taste: changing one
  // should be a visible edit against an assertion, with a new measurement behind
  // it. (`codeToTokens` is synchronous, so every millisecond over budget is a
  // frozen renderer — no typing, no scrolling, no cancelling.)
  it('F-C7: the budget is three independent limits', () => {
    expect(CHAT_HIGHLIGHT_MAX_LINES).toBe(800);
    expect(CHAT_HIGHLIGHT_MAX_CHARS).toBe(64 * 1024);
    expect(CHAT_HIGHLIGHT_MAX_LINE_CHARS).toBe(2000);
  });

  it('F-C7: an ordinary fence, and the empty one, are highlighted', () => {
    expect(shouldHighlightFence('')).toBe(true);
    expect(shouldHighlightFence('const a = 1;')).toBe(true);
    expect(shouldHighlightFence('const a = 1;\nconst b = 2;\n')).toBe(true);
    expect(shouldHighlightFence(bodyOfLines(200, 80))).toBe(true);
  });

  it('F-C7: the line budget is inclusive at 800 and exclusive at 801', () => {
    expect(shouldHighlightFence(bodyOfLines(CHAT_HIGHLIGHT_MAX_LINES))).toBe(true);
    expect(shouldHighlightFence(bodyOfLines(CHAT_HIGHLIGHT_MAX_LINES + 1))).toBe(false);
    // A trailing newline opens an 801st (empty) line, and is counted as one —
    // worth pinning because the caller strips exactly one trailing `\n`, so this
    // is the difference between the fence as authored and the fence as passed.
    expect(shouldHighlightFence(`${bodyOfLines(CHAT_HIGHLIGHT_MAX_LINES)}\n`)).toBe(false);
    expect(shouldHighlightFence(`${bodyOfLines(CHAT_HIGHLIGHT_MAX_LINES - 1)}\n`)).toBe(true);
  });

  it('F-C7: the size budget is inclusive at 64 KB and exclusive one character over', () => {
    const atLimit = bodyOfChars(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(atLimit).toHaveLength(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(shouldHighlightFence(atLimit)).toBe(true);
    expect(shouldHighlightFence(bodyOfChars(CHAT_HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });

  // The one that a byte budget alone does not buy: tokenising is roughly
  // QUADRATIC in the longest single line (measured on `typescript`: 265ms at 4k
  // chars, 1.06s at 8k, 4.5s at 16k, 9.5s at 20k) and every one of those fits
  // inside 64 KB. A minified bundle, a base64 blob, a stringified JSON or a wide
  // type union reaches it with no adversary involved.
  it('F-C7: the longest-line budget is inclusive at 2000 and exclusive at 2001', () => {
    expect(shouldHighlightFence('x'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS))).toBe(true);
    expect(shouldHighlightFence('x'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS + 1))).toBe(false);
  });

  // …at every position, because the loop measures a line when it reaches the
  // newline that ENDS it — so the final line of a body with no trailing newline
  // is measured by a different statement from all the others, and that statement
  // is the one an off-by-one would live in.
  it('F-C7: an over-long line is caught first, middle or last', () => {
    const long = 'x'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS + 1);
    const ok = 'x'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS);
    const short = 'const a = 1;';
    expect(shouldHighlightFence(`${long}\n${short}\n${short}`)).toBe(false);
    expect(shouldHighlightFence(`${short}\n${long}\n${short}`)).toBe(false);
    expect(shouldHighlightFence(`${short}\n${short}\n${long}`)).toBe(false);
    // The last line WITH a trailing newline goes through the loop instead.
    expect(shouldHighlightFence(`${short}\n${long}\n`)).toBe(false);
    // …and the same three positions at exactly the limit are all highlighted,
    // so the assertions above are about the extra character and nothing else.
    expect(shouldHighlightFence(`${ok}\n${short}\n${short}`)).toBe(true);
    expect(shouldHighlightFence(`${short}\n${ok}\n${short}`)).toBe(true);
    expect(shouldHighlightFence(`${short}\n${short}\n${ok}`)).toBe(true);
    expect(shouldHighlightFence(`${short}\n${ok}\n`)).toBe(true);
  });

  // A fence can be inside two budgets and outside the third, which is the whole
  // reason there are three: this one is 8 lines and 16 KB, and still refused.
  it('F-C7: any single budget is enough to refuse', () => {
    const wide = Array.from({ length: 8 }, () => 'x'.repeat(2001)).join('\n');
    expect(wide.length).toBeLessThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(shouldHighlightFence(wide)).toBe(false);
    const tall = bodyOfLines(CHAT_HIGHLIGHT_MAX_LINES + 1, 1);
    expect(tall.length).toBeLessThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(shouldHighlightFence(tall)).toBe(false);
  });

  // What the size budget counts is UTF-16 code units — `String.length`, which is
  // what the tokenizer walks — not UTF-8 bytes. A CJK fence therefore gets ~3x
  // the byte count of an ASCII one, which is the right proxy for tokenizer cost
  // and the wrong reading of the constant's NAME. Pinned so the difference is a
  // decision rather than a surprise.
  it('F-C7: the size budget counts code units, not encoded bytes', () => {
    const cjk = '文'.repeat(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(cjk).toHaveLength(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(CHAT_HIGHLIGHT_MAX_CHARS * 3);
    // Refused on the LINE budget (it is one line), not on the size budget.
    expect(shouldHighlightFence(cjk)).toBe(false);
    const wrapped = '文'.repeat(100);
    const body = Array.from({ length: 600 }, () => wrapped).join('\n');
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(body.length).toBeLessThanOrEqual(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(shouldHighlightFence(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-C5: the security posture, as data AND as a source scan
// ---------------------------------------------------------------------------

const CHAT_DIR = new URL('..', import.meta.url);

function chatSourcePath(file: string): string {
  return fileURLToPath(new URL(file, CHAT_DIR));
}

function readChatSource(file: string): string {
  return readFileSync(chatSourcePath(file), 'utf8');
}

function strippedChatSource(file: string): string {
  return stripComments(readChatSource(file), chatSourcePath(file));
}

/**
 * The strip these scans used to run, kept as a WITNESS.
 *
 * Every fixture below asserts twice: that the real strip keeps the planted
 * token, and that this one loses it. The second assertion is what stops a
 * regression case from decaying into a straw man — if a fixture stops
 * exercising the hole it was written for, it stops proving anything, and
 * nothing else in the file would notice.
 */
function regexOnlyStrip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every source file on the chat markdown rendering path.
 *
 * `ui/ident.tsx` is on it for a reason that is easy to miss: the `code`
 * renderer wraps EVERY inline code span in that file's `CodeInline`, so it is
 * as much a part of the assistant-prose path as the two files in this
 * directory — and it is a shared primitive, so it is also the one file on the
 * path that can be edited by someone who has never read this suite.
 */
const MARKDOWN_PATH_FILES = [
  'ChatMarkdown.tsx',
  'ChatCodeBlock.tsx',
  'chatMarkdownPolicy.ts',
  'chatShiki.ts',
  '../ui/ident.tsx',
] as const;

/**
 * What may not appear anywhere on that path, as a table rather than a run of
 * `expect`s, because each entry is used TWICE: against the real files (must not
 * match) and against a fixture that plants it in code (must match).
 *
 * A negative assertion over a scan has two ways to pass and only one of them is
 * the good one. `plant` is the other one, made visible.
 */
const FORBIDDEN_ON_PATH: ReadonlyArray<{ what: string; re: RegExp; plant: string }> = [
  {
    what: 'the rehype-raw specifier',
    re: /rehype-raw/,
    plant: "import rehypeRawPlugin from 'rehype-raw';",
  },
  { what: 'the rehypeRaw identifier', re: /rehypeRaw/, plant: 'const plugins = [rehypeRaw];' },
  {
    what: 'dangerouslySetInnerHTML',
    re: /dangerouslySetInnerHTML/,
    plant: 'const el = <span dangerouslySetInnerHTML={{ __html: html }} />;',
  },
  { what: 'an <img> element', re: /<img\b/, plant: 'const el = <img alt="" />;' },
  { what: 'a srcSet attribute', re: /\bsrcSet\b/, plant: 'const el = <picture srcSet={set} />;' },
  {
    what: 'a request-capable element',
    re: /<(?:iframe|video|audio|source|embed|object)\b/,
    plant: 'const el = <iframe title="t" />;',
  },
  { what: 'a fetch call', re: /\bfetch\(/, plant: 'const res = fetch(url);' },
  { what: 'an Image constructor', re: /new\s+Image\(/, plant: 'const probe = new Image();' },
  {
    what: 'a CSS background image',
    re: /backgroundImage/,
    plant: 'const style = { backgroundImage: url };',
  },
];

/**
 * The five shapes that made the previous strip lose CODE, each with the banned
 * token it hid. None is invented: shape 1 is `EnhancedInput.tsx`'s
 * `accept="image/*"`, shape 4 is the same file's JSX block that a `/*` inside a
 * string deleted, shape 5 is `deriveChatWorkspaceTree.ts`'s
 * `replace(/^refs\/heads\//, '')`, and `MarkdownPreview.tsx` carries shape 3's
 * `startsWith('//')`. Twelve files under `src/renderer` are affected today.
 */
const FALSE_GREEN_SHAPES: ReadonlyArray<{ shape: string; source: string; hidden: RegExp }> = [
  {
    shape: 'a `//` inside a single-quoted string eats the rest of its line',
    source: [
      "const paths = { rel: 'a//b' }; const el = <span dangerouslySetInnerHTML={{ __html: paths.rel }} />;",
      'export default el;',
    ].join('\n'),
    hidden: /dangerouslySetInnerHTML/,
  },
  {
    shape: 'a `//` inside a template literal does the same',
    source: [
      "const label = `abc//`; import rehypeRaw from 'rehype-raw';",
      'export default label;',
    ].join('\n'),
    hidden: /rehype-raw/,
  },
  {
    shape: "a `data:` url's `//` is not preceded by a colon, so the `[^:]` guard misses it",
    source: [
      'const inert = "data:text/plain,//example"; const res = fetch(inert);',
      'export default res;',
    ].join('\n'),
    hidden: /\bfetch\(/,
  },
  {
    shape: "a `'/*'` in a string pairs with the next real block-comment terminator",
    source: [
      "const opener = '/*';",
      'const el = <picture srcSet={opener} />;',
      'const tail = 1; /* a real comment, whose terminator closes the string above */',
      'export default [el, tail];',
    ].join('\n'),
    hidden: /\bsrcSet\b/,
  },
  {
    shape: 'a regex literal ending in an escaped slash ends in the characters `\\`, `/`, `/`',
    source: [
      'const render = (src: string) => (/^\\/\\//.test(src) ? <img src={src} /> : null);',
      'export default render;',
    ].join('\n'),
    hidden: /<img\b/,
  },
];

describe('F-C5: the component map\u2019s security posture is enumerable', () => {
  it('F-C5: the rehype plugin list is empty, and that is the no-rehype-raw rule', () => {
    expect(CHAT_MARKDOWN_POLICY.rehypePlugins).toEqual([]);
    expect(CHAT_MARKDOWN_POLICY.rawHtml).toBe('escaped-text');
    expect(CHAT_MARKDOWN_POLICY.innerHtml).toBe('never');
  });

  it('F-C5: the remark plugins are the two HTML-incapable ones', () => {
    expect([...CHAT_MARKDOWN_POLICY.remarkPlugins]).toEqual(['remark-gfm', 'remark-breaks']);
  });

  it('F-C5: images are inert and nothing on this path touches the network', () => {
    expect(CHAT_MARKDOWN_POLICY.elements.img).toBe('inert-placeholder');
    expect(CHAT_MARKDOWN_POLICY.network).toBe('none');
  });

  it('F-C5: links are the sanitised-external kind, over the http(s) allow-list', () => {
    expect(CHAT_MARKDOWN_POLICY.elements.a).toBe('sanitized-external');
    expect([...CHAT_MARKDOWN_POLICY.allowedHrefProtocols]).toEqual(['http:', 'https:']);
  });

  it('F-C5: code goes through the primitive and the token renderer, not an HTML string', () => {
    expect(CHAT_MARKDOWN_POLICY.elements.code).toBe('code-inline-primitive');
    expect(CHAT_MARKDOWN_POLICY.elements.pre).toBe('shiki-token-jsx');
  });
});

describe('F-C5: the rendering path really does what the policy claims', () => {
  const sources = MARKDOWN_PATH_FILES.map((file) => ({ file, src: strippedChatSource(file) }));

  /**
   * Prose that exists ONLY inside each file's comments. If any of these
   * survives the strip, comment blanking has stopped working and every negative
   * below is weaker than it reads — the same vacuity guard `fontDomainScan` and
   * `messageTimelineWiring` carry.
   */
  const COMMENT_ONLY_PROSE: Record<(typeof MARKDOWN_PATH_FILES)[number], string> = {
    'ChatMarkdown.tsx': 'Security rule',
    'ChatCodeBlock.tsx': 'Trust boundary',
    'chatMarkdownPolicy.ts': 'load-bearing',
    'chatShiki.ts': 'attacker-influenceable',
    '../ui/ident.tsx': 'optical-compensation',
  };

  it('F-C5: the scanned sources are non-trivial and comment-free', () => {
    for (const { file, src } of sources) {
      // Not `src.length`: the strip blanks rather than deletes, so the length
      // never changes and a length check would be true of an all-comment file.
      // 300 is comfortably under `ui/ident.tsx`, the smallest file on the path,
      // which is 456 characters of code.
      expect(src.replace(/\s+/g, '').length, file).toBeGreaterThan(300);
      expect(src, file).not.toContain(COMMENT_ONLY_PROSE[file]);
      // …and the prose really was there to begin with, or the check above is
      // asserting the absence of something that never existed.
      expect(readChatSource(file), file).toContain(COMMENT_ONLY_PROSE[file]);
    }
    // …and the positive control: the wiring really is in the scanned text.
    const markdown = sources.find((entry) => entry.file === 'ChatMarkdown.tsx')?.src ?? '';
    expect(markdown).toContain('rehypePlugins={REHYPE_PLUGINS}');
    expect(markdown).toContain('urlTransform={chatMarkdownUrlTransform}');
    expect(markdown).toContain('const REHYPE_PLUGINS: [] = [];');
  });

  /**
   * The strip is not allowed to be creative.
   *
   * Blanking in place means the scanned text is the file's own text with holes
   * in it: same length, same offsets, same line numbers, and every difference a
   * space. Anything else — a deletion that JOINS two lines, a replacement that
   * introduces a character — is a way to match something the file does not
   * contain, which is the mirror image of the hole this suite was fixing.
   */
  it('F-C5: the strip only ever blanks, so a match is always really in the file', () => {
    for (const { file, src } of sources) {
      const raw = readChatSource(file);
      expect(src, file).toHaveLength(raw.length);
      const inventions: string[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        if (src[i] !== raw[i] && src[i] !== ' ') inventions.push(`${file}@${i}: ${src[i]}`);
      }
      expect(inventions).toEqual([]);
      // Line structure survives, which is what line-anchored patterns below
      // (`^import … from 'shiki…';$`) depend on.
      expect(src.split('\n'), file).toHaveLength(raw.split('\n').length);
    }
  });

  it('F-C5: no forbidden construct appears anywhere on the path', () => {
    for (const { file, src } of sources) {
      for (const { what, re } of FORBIDDEN_ON_PATH) {
        expect(src, `${file}: ${what}`).not.toMatch(re);
      }
    }
  });

  /**
   * The positive control for every one of those matchers.
   *
   * Each `plant` is put AFTER a string literal containing `//` on the same
   * line — the shape that made all nine assertions above vacuous — so this
   * asserts two things at once: the matcher still recognises what it bans, and
   * the strip still hands it the line to recognise it in.
   */
  it('F-C5: every one of those matchers still fires on planted code', () => {
    for (const { what, re, plant } of FORBIDDEN_ON_PATH) {
      const fixture = `const decoy = 'a//b'; ${plant}\n`;
      expect(stripComments(fixture, 'fixture.tsx'), what).toMatch(re);
      // …and the plant is a real test of the hole, not of nothing: the strip
      // this replaced loses it.
      expect(regexOnlyStrip(fixture), what).not.toMatch(re);
    }
  });

  it('F-C5: the five shapes that used to swallow code are closed', () => {
    for (const { shape, source, hidden } of FALSE_GREEN_SHAPES) {
      expect(stripComments(source, 'fixture.tsx'), shape).toMatch(hidden);
      expect(regexOnlyStrip(source), shape).not.toMatch(hidden);
    }
  });

  // The other direction, and the reason a strip exists at all: a construct named
  // in PROSE is not a construct. All three comment forms, including the trailing
  // one — which is the form that a leading-trivia-only implementation of the
  // strip silently keeps.
  it('F-C5: a forbidden name inside a comment is still stripped, in all three forms', () => {
    // Every plant, once per comment form, so no entry in the table is exempt
    // from either direction. The trailing form is the one a leading-trivia-only
    // implementation of the strip silently keeps.
    const fixture = FORBIDDEN_ON_PATH.map(({ plant }, index) => {
      if (index % 3 === 0) return `// ${plant}`;
      if (index % 3 === 1) return `/* ${plant} */`;
      return `const keep${index} = ${index}; // ${plant}`;
    }).join('\n');
    const stripped = stripComments(fixture, 'fixture.tsx');
    for (const { what, re } of FORBIDDEN_ON_PATH) {
      expect(stripped, what).not.toMatch(re);
    }
    // …while the code on those same lines is untouched.
    for (const index of [2, 5, 8]) {
      expect(stripped).toContain(`const keep${index} = ${index};`);
    }
  });

  /**
   * Why `ui/ident.tsx` is scanned for the bans above but not for the spread
   * order below.
   *
   * That file spreads `{...props}` AFTER its own `className`, which is the
   * shape the next test forbids — and it is correct there, because a shared
   * primitive's caller is supposed to be able to extend its class. What makes it
   * safe on THIS path is the call site: the `code` renderer hands `CodeInline`
   * its children and nothing else, so no property that `remark-gfm` or the model
   * produced can reach that spread. Asserted, because it is the premise of
   * scanning the file for `dangerouslySetInnerHTML` and then not worrying about
   * how it spreads.
   */
  it('F-C5: nothing is spread into the inline-code primitive', () => {
    const markdown = sources.find((entry) => entry.file === 'ChatMarkdown.tsx')?.src ?? '';
    expect(markdown).toContain('<CodeInline>{children}</CodeInline>');
    expect(markdown).not.toMatch(/<CodeInline[^>]*\{\.\.\./);
    // The `code` renderer destructures rather than collecting a rest — a rest
    // parameter here is how props would start flowing again.
    expect(markdown).toContain('code: ({ node: _node, className, children }) => {');
  });

  it('F-C5: the outbound link goes through shell.openExternal, on a sanitised url', () => {
    const markdown = sources.find((entry) => entry.file === 'ChatMarkdown.tsx')?.src ?? '';
    expect(markdown).toContain('const safe = sanitizeMarkdownHref(href);');
    expect(markdown).toContain('window.electronAPI.shell.openExternal(safe)');
    // The one thing that must never appear: forwarding the AUTHOR's string
    // instead of the parsed one.
    expect(markdown).not.toContain('openExternal(href)');
  });

  /**
   * Spread order, as a source fact.
   *
   * `chatMarkdownRender.test.ts` asserts the OUTCOME (a task list keeps its
   * classes, a link title cannot lie), which is the assertion that matters. This
   * one is cheaper and names the cause, so a reordering fails with "you moved
   * the spread" rather than with a diff of markup.
   *
   * The rule: in every renderer that spreads, `{...props}` is the FIRST thing in
   * the element, so no plugin-supplied property can land on top of an attribute
   * this file hardened afterwards.
   */
  it('F-C5: every renderer spreads props before its own attributes', () => {
    const markdown = sources.find((entry) => entry.file === 'ChatMarkdown.tsx')?.src ?? '';
    const spreads = markdown.match(/\{\.\.\.props\}/g) ?? [];
    // Guard against the scan silently matching nothing.
    expect(spreads.length).toBeGreaterThan(10);
    // `<tag {...props}` — the spread immediately after the tag name, every time.
    const leading = markdown.match(/<[a-zA-Z][a-zA-Z0-9]*\s+\{\.\.\.props\}/g) ?? [];
    expect(leading.length).toBe(spreads.length);
    // And the shape that caused the bug is gone: an attribute, then the spread.
    expect(markdown).not.toMatch(/className=\{[^}]*\}\s+\{\.\.\.props\}/);
    // `title` is dropped rather than merged — it is the destination, and the
    // markdown `[text](url "title")` syntax would otherwise overwrite it.
    expect(markdown).toContain('title: _title');
  });

  it('F-C5: shiki is only ever reached through a dynamic import', () => {
    const shiki = sources.find((entry) => entry.file === 'chatShiki.ts')?.src ?? '';
    // The one static import is `import type`, which is erased at build time.
    for (const match of shiki.match(/^import\s+[^\n]*from\s+'shiki[^']*';$/gm) ?? []) {
      expect(match, match).toMatch(/^import type\b/);
    }
    expect(shiki).toContain("import('shiki/core')");
    expect(shiki).toContain("import('shiki/engine/javascript')");
    expect(shiki).toContain("import('shiki/themes/vitesse-dark.mjs')");
    expect(shiki).toContain("import('shiki/langs/typescript.mjs')");
    // Tokens, not an HTML string — the whole reason this module exists rather
    // than reusing `ui/code-block.tsx`.
    expect(shiki).toContain('codeToTokens');
    expect(shiki).not.toContain('codeToHtml');
    // A template-literal import would make the bundler emit a chunk for every
    // grammar shiki ships (~200 of them).
    expect(shiki).not.toMatch(/import\(`/);
    // The singleton is what keeps a session with fifty fences on one
    // highlighter and one grammar load each.
    expect(shiki).toContain('let highlighterPromise');
  });
});

// ---------------------------------------------------------------------------
// Theme sync (not F-C numbered: the observable half needs a DOM)
// ---------------------------------------------------------------------------

describe('the shiki theme follows the applied dark class', () => {
  it('reads the `dark` class off the element the settings store actually toggles', () => {
    const withClasses = (names: string[]) =>
      ({ classList: { contains: (name: string) => names.includes(name) } }) as unknown as Element;
    expect(readDarkClass(withClasses(['dark']))).toBe(true);
    expect(readDarkClass(withClasses(['light']))).toBe(false);
    expect(readDarkClass(withClasses([]))).toBe(false);
    expect(readDarkClass(null)).toBe(false);
    expect(readDarkClass(undefined)).toBe(false);
  });
});
