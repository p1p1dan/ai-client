/**
 * T-29: the assistant-prose Markdown layer's decision logic and class assembly
 * (execution plan §3 T-29 row, D26 option 1).
 *
 * Same discipline as `chatTimelineLayout.ts`: everything that can be decided
 * without a DOM lives in this `.ts` so the node-only vitest environment can
 * truth-table it. The `.tsx` next to it (`ChatMarkdown.tsx`) is then a thin
 * wiring layer over `react-markdown`, holding no policy of its own.
 *
 * ## Why chat gets its own map instead of reusing `files/MarkdownPreview.tsx`
 *
 * That module's `createMarkdownComponents(filePath, rootPath)` exists to resolve
 * RELATIVE image paths against a file on disk and to hand the result to an
 * `<img src>`. Its input is a file the user opened; ours is a token stream
 * authored by a model that a third party can influence (a poisoned README, a
 * tool result, an injected instruction). Reusing it would import, verbatim:
 * `data:` and `blob:` image sources, protocol-relative `//host` upgraded to
 * https, and local-file URL minting — three outbound channels and one local
 * read primitive, all reachable from text the model emits. So: separate map,
 * and the prohibitions below are asserted rather than assumed.
 *
 * ## The five security rules, and where each is enforced
 *
 * 1. **No `rehype-raw`.** It is in the dependency tree (`files/` does not use
 *    it either, but `package.json` carries it), and it is the single plugin
 *    that would turn model-authored HTML into live DOM. `CHAT_MARKDOWN_POLICY
 *    .rehypePlugins` is empty and asserted empty (F-C5); with no rehype plugin,
 *    `react-markdown` passes raw HTML through as TEXT, which React escapes.
 * 2. **Links are `http(s)` only** (`sanitizeMarkdownHref`, F-C1), and the value
 *    handed to `shell.openExternal` is the PARSED, re-serialised URL, never the
 *    author's string — see that function's note on why this is load-bearing.
 * 3. **No image is ever fetched** (`CHAT_MARKDOWN_POLICY.elements.img ===
 *    'inert-placeholder'`): the renderer emits alt text in a chip and no
 *    `src`-bearing element at all, so a remote beacon has nothing to ride on.
 * 4. **No `dangerouslySetInnerHTML` on this path.** Highlighted code is built
 *    from `shiki`'s TOKEN model and rendered as JSX (see `chatShiki.ts`), so the
 *    only strings crossing into the DOM are React text children.
 * 5. **Raw HTML is escaped, not dropped.** Rule 1 gives this for free, and
 *    escaping is the better failure mode: a user who is shown `<script>` knows
 *    the model emitted it, where silent removal hides the attempt.
 *
 * ## Typography (D25, `docs/design-system.md` "Typography（字号）")
 *
 * D25 §Typography is explicit that **all of h1–h6 are `--text-markdown` (15px)**
 * and that heading rank is carried by weight / letter-spacing / colour, not by
 * size ("OpenChamber 的标题层级不靠字号区分"). The letter-spacing third of that
 * triple is then vetoed by D25's own Letter-spacing section — negative tracking
 * is banned below 18px because it collides CJK glyphs — which leaves **two**
 * axes (weight 400 vs 600, colour) for six levels. This module therefore
 * collapses six levels into three ranks and buys a third axis that D25 does not
 * spend: the SECTION-BREAK space above the heading, drawn from the two spacing
 * tiers the turn layout already owns (10px within-turn / 20px between-turn).
 * Pretending to six distinguishable ranks would mean inventing a font-size
 * tier, which is the one thing D25 forbids outright.
 *
 * `font-mono` is deliberately absent from every class below, and that is not an
 * oversight: Tailwind v4's preflight already maps `code` / `kbd` / `samp` /
 * `pre` onto `--default-mono-font-family` (which resolves to our `--font-mono`),
 * so the fenced-code `<pre><code>` is mono without a class — see the long note
 * in `__tests__/fontDomainScan.test.ts`. Inline code goes through the
 * `ui/ident.tsx` `CodeInline` primitive instead, which is D25's own instruction
 * ("不要裸撒 `font-mono`。走三个原语"). Net effect: this feature adds **zero**
 * entries to the A1 mono whitelist.
 */

/**
 * The only two URL schemes an assistant-authored link may carry.
 *
 * This is a whitelist and must stay one. `mailto:` and `vscode:` are excluded
 * on purpose — both are perfectly ordinary, and both are also a way for model
 * output to make the OS open an application with attacker-chosen arguments.
 */
export const CHAT_MARKDOWN_ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

/**
 * Decide whether an assistant-authored href may become a real link (F-C1).
 *
 * Returns the **parsed and re-serialised** URL, or `null` for "render the label
 * as plain text, do not make it a link".
 *
 * Returning `url.href` rather than the input is the point of the function, not
 * a tidiness choice. `preload/index.ts:810` implements `shell.openExternal` as
 * a direct pass-through to Electron's `shell.openExternal` with **no protocol
 * check of its own**, so whatever this returns is handed to the OS handler.
 * Validating one string and forwarding a different one is exactly the parser
 * differential that makes URL allow-lists fail; re-serialising removes the gap
 * by construction — what was checked IS what is sent.
 *
 * Everything else is delegated to the WHATWG URL parser rather than
 * re-implemented, which is what makes the obfuscation cases fall out instead of
 * needing a rule each:
 *  - schemes are lower-cased during parsing, so `JavaScript:` is `javascript:`;
 *  - ASCII tab/CR/LF are removed from the input during parsing, so
 *    `java\nscript:alert(1)` is `javascript:alert(1)`;
 *  - leading/trailing C0 controls and spaces are trimmed, so `https://…`
 *    still parses as https while ` javascript:…` still parses as javascript;
 *  - a relative reference (`./x`, `/x`, `x`) and a protocol-relative one
 *    (`//evil.example`) both THROW without a base, and no base is supplied, so
 *    "absolute http(s) only" needs no separate test.
 */
export function sanitizeMarkdownHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string' || href.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const allowed: readonly string[] = CHAT_MARKDOWN_ALLOWED_PROTOCOLS;
  if (!allowed.includes(parsed.protocol)) return null;
  return parsed.href;
}

/**
 * `react-markdown`'s `urlTransform` hook, expressed over the same gate.
 *
 * The component map below already refuses to build an `<a>` for a rejected
 * href, so this is the second of two independent gates rather than the only
 * one. It exists because `urlTransform` runs on EVERY url-bearing property the
 * parser produces, including ones a future component override might start
 * consuming — belt and braces on a boundary where the failure is silent.
 */
export function chatMarkdownUrlTransform(url: string): string {
  return sanitizeMarkdownHref(url) ?? '';
}

// ---------------------------------------------------------------------------
// Fenced code: language normalisation (F-C2)
// ---------------------------------------------------------------------------

/**
 * The languages the chat highlighter will load, keyed by their canonical shiki
 * id. Deliberately a CLOSED list rather than shiki's full bundle: each entry is
 * an async chunk that only downloads when a reply actually contains that fence,
 * and an open list would let one exotic fence pull an unbounded grammar in.
 * Anything outside it renders as an un-highlighted `<pre>`, which is a correct
 * rendering, not a failure.
 */
export const CHAT_CODE_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsx',
  'kotlin',
  'lua',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'shell',
  'sql',
  'swift',
  'toml',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const;

export type ChatCodeLanguage = (typeof CHAT_CODE_LANGUAGES)[number];

/**
 * Aliases models actually emit, mapped onto the canonical ids above.
 *
 * Mirrors `ui/code-block.tsx`'s table where they overlap; it is a separate table
 * rather than a shared import because that one is keyed to that component's own
 * (larger, `dangerouslySetInnerHTML`-based) loader and the two lists are allowed
 * to diverge.
 */
const CHAT_CODE_LANGUAGE_ALIASES: Readonly<Record<string, ChatCodeLanguage>> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  patch: 'diff',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellscript: 'shell',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml',
};

/**
 * Normalise a fence's info string to a canonical, loadable language id, or
 * `null` for "no highlighting" (F-C2).
 *
 * `null` is a first-class answer, not an error path: an unknown fence renders
 * as plain `<pre>` with the same box, so the reply is never worse off than the
 * pre-T-29 plain-text rendering.
 */
export function normalizeCodeLanguage(raw: string | null | undefined): ChatCodeLanguage | null {
  if (typeof raw !== 'string') return null;
  // A fence's info string may carry attributes after the language
  // (```ts twoslash / ```js {1,3-4}); only the first word names the grammar.
  const first =
    raw
      .trim()
      .split(/[\s,{]/, 1)[0]
      ?.toLowerCase() ?? '';
  if (first.length === 0) return null;
  const supported: readonly string[] = CHAT_CODE_LANGUAGES;
  if (supported.includes(first)) return first as ChatCodeLanguage;
  return CHAT_CODE_LANGUAGE_ALIASES[first] ?? null;
}

/** Pull the language out of `react-markdown`'s `language-xxx` class on a `<code>`. */
export function codeLanguageFromClassName(className: string | null | undefined): string | null {
  if (typeof className !== 'string') return null;
  return /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? null;
}

/**
 * Whether a `<code>` node is a fenced BLOCK rather than an inline span (F-C2).
 *
 * `react-markdown` v10 dropped the `inline` prop, and its own documented recipe
 * keys off the `language-*` class — which misses a fence opened with no info
 * string at all. The newline fallback closes the common half of that gap: a
 * multi-line body cannot be an inline span. The residue (a fence with neither a
 * language nor a newline, ```` ```\nfoo\n``` ````) still renders as an inline
 * chip; that is the same behaviour `files/MarkdownPreview.tsx` has shipped with,
 * and it degrades to "correct text, wrong box" rather than to anything unsafe.
 */
export function isFencedCodeBlock(input: { className?: string | null; text: string }): boolean {
  return codeLanguageFromClassName(input.className) !== null || input.text.includes('\n');
}

// ---------------------------------------------------------------------------
// Streaming gate (F-C3)
// ---------------------------------------------------------------------------

export interface MarkdownGateInput {
  /** Id of the text block about to be rendered. */
  blockId: string;
  /**
   * The one block in this item's source message that may still be streaming.
   * `MessageTimeline` derives it per message as "the last block, while the turn
   * is active", and `null` whenever the turn is not active — which is also the
   * state every restored (`h:`-prefixed) history message is in.
   */
  streamingBlockId: string | null;
}

/**
 * Whether a text block is finished enough to be re-rendered as Markdown (F-C3).
 *
 * ARD's ruling is "plain text while streaming, Markdown once the message
 * completes", and the reason is reflow: a fence is not a fence until its
 * closing ``` arrives, so parsing every token would flip whole paragraphs in
 * and out of a code box as the reply is typed. One reflow at the end is the
 * price; a strobing one is not.
 *
 * The signal is the streaming-block id the timeline ALREADY derives, not a new
 * store field — `chatSessions.ts` is a red-line file and `ChatMessage` has no
 * completion flag. That id is conservative in exactly the right direction: it
 * marks the last block of every body message while the turn is active, so
 * mid-turn prose that is already final also waits, and the whole turn converts
 * in a single frame when it ends instead of block by block.
 */
export function shouldRenderMarkdown({ blockId, streamingBlockId }: MarkdownGateInput): boolean {
  return blockId !== streamingBlockId;
}

// ---------------------------------------------------------------------------
// Class assembly (F-C4)
// ---------------------------------------------------------------------------

/**
 * Vertical rhythm inside one prose block, in Tailwind spacing steps.
 *
 * Both values are the turn layout's own tiers, re-used rather than re-invented:
 * `2.5` = 10px is P-17's "within a turn" beat (`turnBodyClass()`'s gap), `5` =
 * 20px is A07 `:846`'s turn-to-turn beat. No third tier is introduced, which is
 * what F-C4 pins.
 */
const BLOCK_GAP = 'mt-2.5 first:mt-0';
const SECTION_GAP = 'mt-5 first:mt-0';

/**
 * The Markdown root — one flex item inside `turnBodyClass()`.
 *
 * Carries no `overflow-*` / `transform` / `filter` / `contain`. That is a
 * structural prohibition, not a style preference: T-31's pinned user bubble is
 * a plain `position: sticky` scoped by the turn's `<section>`, and each of those
 * four properties either disables sticky outright or re-parents its containing
 * block. Horizontal scrolling is therefore pushed down to the two LEAF surfaces
 * that genuinely need it (fenced code, GFM tables), which are inside the answer
 * body and on nobody's sticky chain.
 *
 * `whitespace-pre-wrap` is deliberately absent (it is the pre-T-29 plain-text
 * renderer's class): `remark-breaks` turns a single newline into a `<br>`, so
 * chat's "one newline is a line break" behaviour survives the switch, and
 * keeping `pre-wrap` on top of it would double every blank line.
 */
export function chatMarkdownRootClass(): string {
  return 'min-w-0 break-words text-markdown leading-normal text-foreground';
}

export function chatMarkdownParagraphClass(): string {
  return BLOCK_GAP;
}

/**
 * Heading rank (see the module note for why there are three of them, not six).
 *
 * Every level pins `text-markdown` explicitly instead of relying on Tailwind
 * preflight's `font-size: inherit` reset — a heading that silently picks up a
 * UA `2em` inside a 45rem reading column is precisely the regression D25's
 * "标题不靠字号" ruling exists to prevent, and an explicit token fails loudly if
 * preflight ever changes.
 *
 * No `tracking-*` at any level: D25's gradient stops at "<18px 一律非负", these
 * are all 15px, and the non-negative value is the default.
 */
export function chatMarkdownHeadingClass(level: 1 | 2 | 3 | 4 | 5 | 6): string {
  if (level <= 3) return `${SECTION_GAP} text-markdown font-semibold text-foreground`;
  if (level <= 5) return `${BLOCK_GAP} text-markdown font-semibold text-muted-foreground`;
  return `${BLOCK_GAP} text-markdown font-normal text-muted-foreground`;
}

/**
 * Bullet / ordered lists.
 *
 * `[&_ul]:mt-1` / `[&_ol]:mt-1` re-tighten NESTED lists: without them a sublist
 * inherits the 10px block gap and a three-level outline reads as three separate
 * paragraphs. Descendant variants beat the plain `mt-2.5` on specificity, which
 * is the whole mechanism.
 *
 * `[&_li.task-list-item]:list-none` is the GFM task-list case. `remark-gfm`
 * marks those items with `.task-list-item` and every GFM stylesheet hides their
 * marker, because the checkbox IS the marker — without this a `- [ ] item`
 * renders a bullet AND a checkbox. It is scoped to the marked `<li>` rather than
 * applied to the whole list so a list that mixes task and prose items keeps
 * bullets on the prose ones.
 */
export function chatMarkdownListClass(ordered: boolean): string {
  return [
    BLOCK_GAP,
    'ml-5 list-outside space-y-1',
    ordered ? 'list-decimal' : 'list-disc',
    '[&_ul]:mt-1 [&_ol]:mt-1',
    '[&_li.task-list-item]:list-none',
  ].join(' ');
}

/**
 * External link. `text-primary` + underline is the repo's existing link
 * treatment (`files/MarkdownPreview.tsx`); what is NOT shared is where the href
 * comes from — see `sanitizeMarkdownHref`.
 */
export function chatMarkdownLinkClass(): string {
  return 'text-primary underline underline-offset-4 hover:text-primary/80';
}

/**
 * Fenced code block (`<pre>`).
 *
 * `text-code` is D25's 13px optical-compensation tier against 15px sans body
 * copy. No `font-mono`: preflight already maps `pre` onto `--font-mono` (see the
 * module note), and spelling the class would add this file to the A1 whitelist
 * for no rendered difference.
 *
 * `overflow-x-auto` lives HERE and not on the root — a long line scrolls inside
 * its own box instead of widening the reading column, and the property stays off
 * the sticky chain (F-C4).
 */
export function chatMarkdownCodeBlockClass(): string {
  return `${BLOCK_GAP} overflow-x-auto rounded-sm border border-border bg-muted/50 p-2.5 text-code leading-snug`;
}

/** GFM table, wrapped so the horizontal scroll is the TABLE's, not the column's. */
export function chatMarkdownTableWrapClass(): string {
  return `${BLOCK_GAP} overflow-x-auto`;
}

export function chatMarkdownTableClass(): string {
  return 'w-full border-collapse border border-border';
}

export function chatMarkdownTableCellClass(kind: 'head' | 'body'): string {
  return kind === 'head'
    ? 'border border-border bg-muted/50 px-2.5 py-1 text-left font-semibold'
    : 'border border-border px-2.5 py-1';
}

export function chatMarkdownBlockquoteClass(): string {
  return `${BLOCK_GAP} border-l-2 border-border pl-2.5 text-muted-foreground`;
}

export function chatMarkdownHrClass(): string {
  return `${BLOCK_GAP} border-border`;
}

/**
 * The GFM footnote block's own separation, or `''` for any other `<section>`.
 *
 * Keyed off `remark-gfm`'s `footnotes` class rather than applied to every
 * `<section>`, because the component map overrides the ELEMENT and markdown has
 * no other way to produce one today — a future plugin that does would otherwise
 * silently inherit a footnote's spacing. `SECTION_GAP` (20px) rather than the
 * block tier: this is the boundary between the answer and its apparatus, which
 * is the same weight as a top-level heading's break.
 *
 * A `border-t` is deliberately not added. The footnote list already carries its
 * own markers, and a rule here would be the third horizontal line in a reply
 * that may also contain `---` and a table.
 */
export function chatMarkdownFootnotesClass(className: string | null | undefined): string {
  if (typeof className !== 'string') return '';
  return className.split(/\s+/).includes('footnotes')
    ? `${SECTION_GAP} text-meta text-muted-foreground`
    : '';
}

/**
 * The inert stand-in for `![alt](src)` (security rule 3).
 *
 * Renders as a chip carrying the alt text and NOTHING that can issue a request:
 * no `<img>`, no `src`, no `background-image`, no `srcSet`. A remote image in an
 * assistant reply is a read receipt for whoever controls the URL — it discloses
 * that the reply was rendered, when, and from which IP — and a local one has no
 * meaning in a chat transcript, so there is no case worth the channel.
 */
export function chatMarkdownImagePlaceholderClass(): string {
  return 'inline-flex max-w-full items-center gap-1 rounded-xs border border-border bg-muted/50 px-1.5 align-middle text-meta text-muted-foreground';
}

// ---------------------------------------------------------------------------
// Highlighted-token styling (F-C4)
// ---------------------------------------------------------------------------

/**
 * TextMate font-style bits, as shiki reports them on a token.
 *
 * Mirrored as plain numbers rather than imported from
 * `@shikijs/vscode-textmate`'s `FontStyle` enum so that this module — the one
 * the node test suite loads — stays free of any shiki import, static or type.
 * Source: `FontStyle` in `@shikijs/vscode-textmate`.
 */
export const CHAT_CODE_FONT_STYLE = {
  italic: 1,
  bold: 2,
  underline: 4,
  strikethrough: 8,
} as const;

/** One highlighted token, reduced to what the renderer needs (see `chatShiki.ts`). */
export interface ChatCodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

/**
 * The inline style for one highlighted token.
 *
 * This is the ONLY value on the markdown path that originates outside React's
 * text-escaping, so the trust boundary is worth stating: `color` comes from a
 * shiki theme that ships in this bundle, never from the model's text, and React
 * applies a style OBJECT by assigning CSSOM properties one at a time rather
 * than by writing a `style="…"` string — so even a hostile colour value could
 * not close the attribute or inject a second declaration. The token's `content`
 * is a substring of the model's own code fence and is rendered as a text child,
 * which React escapes.
 *
 * `underline` / `strikethrough` are dropped on purpose: neither appears in the
 * two bundled themes, and the two that do (italic, bold) are the only styles
 * D25 permits on a mono element (weights 400/700 only, no synthesis).
 */
export function chatCodeTokenStyle(token: ChatCodeToken): {
  color?: string;
  fontStyle?: 'italic';
  fontWeight?: 'bold';
} {
  const bits = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(bits & CHAT_CODE_FONT_STYLE.italic ? { fontStyle: 'italic' as const } : {}),
    ...(bits & CHAT_CODE_FONT_STYLE.bold ? { fontWeight: 'bold' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// The policy object (F-C5)
// ---------------------------------------------------------------------------

/**
 * The component map's security posture, as data.
 *
 * This exists so the prohibitions can be ASSERTED rather than reviewed: a
 * component map is a bag of closures and a test can only look at it, not at what
 * it renders. Every field below is either consumed by `ChatMarkdown.tsx` (the
 * protocol list, the rehype list) or paired with a static source scan in
 * `__tests__/chatMarkdownPolicy.test.ts` that checks the file really does what the
 * field claims — the object on its own would only assert that someone typed it.
 */
export const CHAT_MARKDOWN_POLICY = {
  /** Applied in this order. Both are already dependencies; neither can emit HTML. */
  remarkPlugins: ['remark-gfm', 'remark-breaks'] as const,
  /**
   * MUST stay empty. `rehype-raw` is in `package.json`, and it is the single
   * switch that would turn model-authored HTML into live DOM. With no rehype
   * plugin at all, `react-markdown` hands raw HTML to React as text.
   */
  rehypePlugins: [] as const,
  allowedHrefProtocols: CHAT_MARKDOWN_ALLOWED_PROTOCOLS,
  /** How each non-prose element is handled. */
  elements: {
    /** No `<img>`, no `src`, no request — an alt-text chip (F-C5). */
    img: 'inert-placeholder',
    /** `http(s)` only, opened through `shell.openExternal`; anything else is plain text. */
    a: 'sanitized-external',
    /** `ui/ident.tsx`'s `CodeInline` primitive (D25 §2.5). */
    code: 'code-inline-primitive',
    /** shiki TOKENS rendered as JSX — never an HTML string. */
    pre: 'shiki-token-jsx',
  },
  /** Raw HTML in the source reaches the DOM as escaped text, never as markup. */
  rawHtml: 'escaped-text',
  /** No renderer in the map issues a network request of any kind. */
  network: 'none',
  /** No `dangerouslySetInnerHTML` anywhere on the chat markdown path. */
  innerHtml: 'never',
} as const;
