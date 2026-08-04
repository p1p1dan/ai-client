import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_CODE_FONT_STYLE,
  CHAT_CODE_LANGUAGES,
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
  isFencedCodeBlock,
  normalizeCodeLanguage,
  sanitizeMarkdownHref,
  shouldRenderMarkdown,
} from '../chatMarkdownPolicy';
import { chatTurnClass, turnBodyClass, turnBubbleBandClass } from '../chatTimelineLayout';
import { readDarkClass } from '../useDarkClass';

/**
 * T-29 (execution plan §3 T-29 row, D26 option 1): the assistant-prose Markdown
 * layer, F-C1 … F-C5.
 *
 * The suite has two halves and they assert different KINDS of thing:
 *
 *  - F-C1 … F-C4 are ordinary truth tables and class assertions over pure
 *    functions;
 *  - F-C5 is the security posture, and a policy OBJECT can only ever assert
 *    that someone typed the object. So it is paired with a static scan of the
 *    two `.tsx` files that do the rendering, which is what actually forbids
 *    `rehype-raw`, `dangerouslySetInnerHTML` and any `src`-bearing element.
 *    Neither half is sufficient alone; both are cheap.
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
// F-C5: the security posture, as data AND as a source scan
// ---------------------------------------------------------------------------

const CHAT_DIR = new URL('..', import.meta.url);

function readChatSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, CHAT_DIR)), 'utf8');
}

/**
 * Comments blanked, string literals kept.
 *
 * The same shape `fontDomainScan.test.ts` uses, and for the same reason: this
 * file's own doc comments necessarily NAME the things they ban (`rehype-raw`,
 * `dangerouslySetInnerHTML`), so a raw-text scan would fail on the explanation
 * rather than on the code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every source file on the chat markdown rendering path. */
const MARKDOWN_PATH_FILES = [
  'ChatMarkdown.tsx',
  'ChatCodeBlock.tsx',
  'chatMarkdownPolicy.ts',
  'chatShiki.ts',
] as const;

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
  const sources = MARKDOWN_PATH_FILES.map((file) => ({
    file,
    src: stripComments(readChatSource(file)),
  }));

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
  };

  it('F-C5: the scanned sources are non-trivial and comment-free', () => {
    for (const { file, src } of sources) {
      expect(src.length, file).toBeGreaterThan(400);
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

  it('F-C5: rehype-raw is imported nowhere on the path', () => {
    for (const { file, src } of sources) {
      expect(src, file).not.toContain('rehype-raw');
      expect(src, file).not.toContain('rehypeRaw');
    }
  });

  it('F-C5: dangerouslySetInnerHTML appears nowhere on the path', () => {
    for (const { file, src } of sources) {
      expect(src, file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('F-C5: no element on the path can issue a request', () => {
    for (const { file, src } of sources) {
      // No `<img>` is ever constructed, so no `src` is ever resolved.
      expect(src, file).not.toMatch(/<img\b/);
      expect(src, file).not.toMatch(/\bsrcSet\b/);
      expect(src, file).not.toMatch(/<(?:iframe|video|audio|source|embed|object)\b/);
      expect(src, file).not.toMatch(/\bfetch\(/);
      expect(src, file).not.toMatch(/new\s+Image\(/);
      expect(src, file).not.toMatch(/backgroundImage/);
    }
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
