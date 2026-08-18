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
 * spend: the SECTION-BREAK space above the heading, drawn from prose's own two
 * spacing tiers (14px block / 24px section — see `BLOCK_GAP` / `SECTION_GAP`).
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
  if (!CHAT_MARKDOWN_HOST_PATTERN.test(parsed.hostname)) return null;
  return parsed.href;
}

/**
 * What a hostname may contain once the parser is done with it.
 *
 * The URL parser percent-DECODES into the host and, unlike the path, does not
 * re-encode the result: `https://ex%22ample.com/` comes back with a literal `"`
 * in `hostname`, and `` ` ``, `{`, `}`, `&`, `$`, `;`, `!`, `'`, `(`, `)`, `*`,
 * `+`, `,`, `=`, `~` survive the same way. That string is what reaches
 * `shell.openExternal`, and on Windows the `https` handler is resolved from the
 * registry and substituted into a `%1` command template.
 *
 * This is hardening, not a hole being closed: the parser already REJECTS every
 * character needed to split a new argv token (space, tab, `\`, `|`, `^`, `<`,
 * `>`, `#`, `%`, `:`, `?`, `@`, `[`, `]`, `/`), so the classic `" & calc "`
 * shape renders as plain text today. The rule is simply that a hostname has no
 * business containing punctuation outside this set, and the cheapest place to
 * be sure is before the string leaves for the OS.
 *
 * Deliberately applied to `hostname`, not `host`: it excludes the port (which
 * is digits the parser has already validated) and userinfo. IDN is not a false
 * positive — IDNA runs during parsing, so `münchen.de` is `xn--mnchen-3ya.de`
 * and `例え.jp` is `xn--r8jz45g.jp` by the time it is read here. The bracket
 * branch keeps IPv6 literals (`[::1]`) working.
 */
const CHAT_MARKDOWN_HOST_PATTERN = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/;

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
  // (```ts twoslash / ```js {1,3-4} / ```ts:src/index.ts, the last being the
  // Docusaurus filename form models copy out of documentation corpora); only
  // the first word names the grammar.
  const first =
    raw
      .trim()
      .split(/[\s,{:]/, 1)[0]
      ?.toLowerCase() ?? '';
  if (first.length === 0) return null;
  const supported: readonly string[] = CHAT_CODE_LANGUAGES;
  if (supported.includes(first)) return first as ChatCodeLanguage;
  // `Object.hasOwn`, not a bare index: the info string is model-authored, and a
  // plain object-literal lookup answers `__proto__` with `Object.prototype` and
  // `constructor` with `Object` — both non-null, so `?? null` would not fire and
  // this function would return a NON-string as `ChatCodeLanguage`. That value
  // then skips `highlightChatCode`'s `if (!language)` fast path and builds the
  // whole shiki singleton for a fence that can never be highlighted, which is
  // the exact outcome the closed list exists to prevent.
  return Object.hasOwn(CHAT_CODE_LANGUAGE_ALIASES, first)
    ? CHAT_CODE_LANGUAGE_ALIASES[first]
    : null;
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
 * string at all. Two fallbacks close that gap, and between them the residue the
 * earlier revision of this comment described is empty:
 *
 *  - **a newline in the body.** A fence's body always ends in one (the closing
 *    ```` ``` ```` sits on its own line), so ```` ```\nfoo\n``` ```` is caught
 *    here — the worked example this comment used to call the residue was
 *    measured and is in fact handled;
 *  - **no children at all.** The genuinely empty fence (```` ```\n``` ````) is
 *    the one case with neither a language nor a newline: `react-markdown` hands
 *    the renderer `children === undefined`, where an inline span always has a
 *    non-empty string. Without this clause it rendered as an empty `CodeInline`
 *    chip — a stray 8px grey pill sitting in the prose with no block spacing.
 */
export function isFencedCodeBlock(input: {
  className?: string | null;
  text: string;
  /** `false` only when the `code` renderer was handed no children whatsoever. */
  hasChildren?: boolean;
}): boolean {
  if (codeLanguageFromClassName(input.className) !== null) return true;
  if (input.text.includes('\n')) return true;
  return input.hasChildren === false;
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
 */
export function shouldRenderMarkdown({ blockId, streamingBlockId }: MarkdownGateInput): boolean {
  return blockId !== streamingBlockId;
}

/** One body message, reduced to what the gate needs (see `deriveStreamingBlockIds`). */
export interface StreamingGateMessage {
  id: string;
  /** The message's last block id — the only block that can still be in flight. */
  lastBlockId: string | null;
  /**
   * Whether the app has metadata for this message AT ALL. Restored (`h:`)
   * history has none, which is how "replayed, therefore finished" is told apart
   * from "started this session and not finished yet".
   */
  tracked: boolean;
  /** Whether that metadata carries a `completedAt`. */
  completed: boolean;
}

/**
 * Which block of each body message is still streaming (F-C3).
 *
 * Pure, and deliberately so: this used to be an inline `useMemo` in
 * `MessageTimeline.tsx`, where the node-only suite could not see it — and two
 * defects lived in that blind spot until the T-29 review:
 *
 *  1. **the gate was session-wide.** The caller passed one `isActiveTurn` flag
 *     to EVERY turn, so starting a new turn re-marked the last block of every
 *     message in every EARLIER turn as "streaming" and dropped the whole
 *     session's finished answers back to plain text — headings, lists, tables
 *     and code boxes disappearing (and the scroll position jumping) for as long
 *     as the new reply took, then all snapping back at once;
 *  2. **the gate was not monotonic.** It keyed off `isTurnActive`, which
 *     excludes `waiting_permission` / `waiting_question`, so an authorization
 *     round-trip flipped blocks to Markdown mid-stream and back again — two
 *     extra full reflows, precisely the strobing this gate exists to prevent.
 *
 * Both are fixed by asking a different question. `turnInFlight` is the caller's
 * conjunction of "the session is in flight (including permission waits)" and
 * "this is the LAST turn" — only that turn can contain a streaming block — and
 * per message the answer now comes from its own metadata rather than from
 * session state. `completedAt` only ever goes from unset to set, so a block
 * converts to Markdown exactly once and never reverts; a message the app never
 * tracked (restored history) is finished by definition; and an aborted turn,
 * where `completedAt` may never arrive, is released by `turnInFlight` going
 * false. This also narrows the T-29 as-built deviation on (c): an intermediate
 * message that completes mid-turn now converts immediately instead of waiting
 * for the whole turn to end.
 */
export function deriveStreamingBlockIds(input: {
  messages: readonly StreamingGateMessage[];
  turnInFlight: boolean;
}): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const message of input.messages) {
    const streaming = input.turnInFlight && message.tracked && !message.completed;
    map.set(message.id, streaming ? message.lastBlockId : null);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Class assembly (F-C4)
// ---------------------------------------------------------------------------

/**
 * Vertical rhythm inside one prose block, in Tailwind spacing steps.
 *
 * Prose owns its OWN two tiers: `3.5` = 14px between blocks, `6` = 24px to open
 * a section. Both come from F5 D1-b (user decision, 2026-08-18 — see
 * `docs/plans/2026-08-18-f456-readability-composer-spec.md` §1, drawn from the
 * readability comparison), the same decision that took body leading to 1.625.
 *
 * They are deliberately NOT the turn skeleton's 10 / 20 any more. That coupling
 * is what this note used to record, and breaking it IS the change rather than an
 * oversight: the skeleton's beat is interface structure (band, head, footer)
 * while these two are long-form reading rhythm, and the two get revised for
 * different reasons — the same argument that keeps `--text-meta` and
 * `--text-code` as two tokens although both are 13px. Re-coupling would also
 * mean re-deciding a value that is not free: the 20px turn beat is
 * `readingColumnSpacingClass()`'s `space-y-2.5` plus `turnBubbleBandClass()`'s
 * `py-2.5`, and that padding doubles as the pinned bubble's opaque buffer.
 *
 * What F-C4 actually pins is untouched: prose has exactly TWO tiers and invents
 * no third. Only the values those tiers hold have changed.
 */
const BLOCK_GAP = 'mt-3.5 first:mt-0';
const SECTION_GAP = 'mt-6 first:mt-0';

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
 *
 * `select-text` is load-bearing, not decoration: `globals.css` sets
 * `user-select: none` on `*` app-wide, and `.select-text` (plus every
 * descendant) is its opt-back-in whitelist — the same one
 * `files/MarkdownPreview.tsx` uses. Without it the transcript's prose cannot be
 * selected at all and copy is only possible through the turn's copy button
 * (found in T-29 GUI review).
 */
export function chatMarkdownRootClass(): string {
  return 'min-w-0 select-text break-words text-markdown leading-relaxed text-foreground';
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
 * `[&_ul]:mt-1.5` / `[&_ol]:mt-1.5` re-tighten NESTED lists: without them a
 * sublist inherits the 14px block gap and a three-level outline reads as three
 * separate paragraphs. Descendant variants beat the plain `mt-3.5` on
 * specificity, which is the mechanism — but the measured result is 0px, not the
 * 6px the utility spells: a nested list is its `<li>`'s first ELEMENT child (the
 * text node does not count), so `first:mt-0` at 0-2-0 outranks the descendant
 * rule at 0-1-1. Flush is the wanted rendering; the utility stays as the guard
 * for the sublist that is NOT first (a list item with prose above its sublist).
 * D1-b sets that guard to the ITEM spacing rather than a tier of its own,
 * because the one case it bites — prose, then a sublist, inside one item — is
 * an item-to-item distance by definition.
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
    'ml-5 list-outside space-y-1.5',
    ordered ? 'list-decimal' : 'list-disc',
    '[&_ul]:mt-1.5 [&_ol]:mt-1.5',
    '[&_li.task-list-item]:list-none',
  ].join(' ');
}

/**
 * External link. `text-primary` + underline is the repo's existing link
 * treatment (`files/MarkdownPreview.tsx`); what is NOT shared is where the href
 * comes from — see `sanitizeMarkdownHref`.
 */
export function chatMarkdownLinkClass(): string {
  // The hover feedback moves the UNDERLINE, not the text colour. `text-primary`
  // measures 4.73:1 on light / 5.49:1 on dark; the `hover:text-primary/80` this
  // used to carry dropped that to 3.39:1 / 3.93:1, i.e. under WCAG AA's 4.5:1
  // for body text in both themes — a hover state nobody can read is not a hover
  // state, and `docs/design-system.md`'s "已知偏差" table is for deviations we
  // decided to keep, not a place to file new ones. Decoration alpha carries the
  // same affordance and is not text contrast.
  return 'text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary';
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
  return `${BLOCK_GAP} overflow-x-auto rounded-sm border border-border bg-muted/50 p-3 text-code leading-normal`;
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
    ? 'border border-border bg-muted/50 px-2.5 py-1.5 text-left font-semibold'
    : 'border border-border px-2.5 py-1.5';
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
 * silently inherit a footnote's spacing. `SECTION_GAP` (24px) rather than the
 * block tier: this is the boundary between the answer and its apparatus, which
 * is the same weight as a top-level heading's break.
 *
 * A `border-t` is deliberately not added. The footnote list already carries its
 * own markers, and a rule here would be the third horizontal line in a reply
 * that may also contain `---` and a table.
 */
export function chatMarkdownFootnotesClass(className: unknown): string {
  // Both shapes, for the same reason `isFootnoteBackref` takes both: which one
  // arrives is a `react-markdown` / `hast` implementation detail, and getting it
  // wrong here fails SILENTLY — the footnote block simply loses its separation
  // and reads as one more list item. It is a string on the current pair.
  const names =
    typeof className === 'string'
      ? className.split(/\s+/)
      : Array.isArray(className)
        ? className
        : [];
  return names.includes('footnotes') ? `${SECTION_GAP} text-meta text-muted-foreground` : '';
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
// Highlight budget (F-C7)
// ---------------------------------------------------------------------------

/**
 * Above any of these, a fence is rendered plain (F-C7).
 *
 * `codeToTokens` is SYNCHRONOUS — the `async` on `highlightChatCode` covers the
 * dynamic imports, not the tokenizer — so the whole renderer process stops for
 * its duration: no typing, no scrolling, no cancelling, and the tokens of the
 * reply still streaming in queue up behind it.
 *
 * The three limits are not three ways of saying the same thing, and the third
 * is the one that matters. Measured with this module's own engine and themes:
 *
 *  - **line count** is cheap and near-linear — 5000 lines over 120k chars costs
 *    262ms, and the DOM commit (≈110k spans) dominates it;
 *  - **total size** bounds that DOM commit. Counted in UTF-16 code units
 *    rather than UTF-8 bytes, which is deliberate and is why the constant is
 *    named `_CHARS`: the tokenizer's cost tracks units of text, not their
 *    encoded width, so a CJK fence should not get a third of the budget for
 *    being CJK;
 *  - **the longest single line is roughly QUADRATIC**, and it is the reason a
 *    byte budget alone is not a guard: `typescript` takes 265ms at 4k chars on
 *    one line, 1.06s at 8k, 4.5s at 16k and 9.5s at 20k — all of which fit
 *    inside a 64 KB fence. A minified bundle, a base64 literal, a stringified
 *    JSON or a wide type union in a ```ts fence gets there with no adversary
 *    involved, and `typescript` / `tsx` / `javascript` / `bash` are exactly the
 *    grammars a coding chat sees most (`python` / `json` are unaffected).
 *    2000 chars keeps the worst case near 130ms.
 *
 * Because of the F-C3 streaming gate the highlight lands AT turn completion —
 * i.e. the instant the user reaches for the input box — so a freeze here is
 * maximally badly timed. The fallback is not a failure state: an un-highlighted
 * fence is the same box with the same text, one text node instead of thousands
 * of spans, which is why the plain path costs nothing at any size.
 */
export const CHAT_HIGHLIGHT_MAX_LINES = 800;
export const CHAT_HIGHLIGHT_MAX_CHARS = 64 * 1024;
export const CHAT_HIGHLIGHT_MAX_LINE_CHARS = 2000;

/** Whether a fence is small enough to be worth (and safe to) highlight (F-C7). */
export function shouldHighlightFence(code: string): boolean {
  if (code.length > CHAT_HIGHLIGHT_MAX_CHARS) return false;
  let lines = 1;
  let lineStart = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) !== 10 /* \n */) continue;
    if (i - lineStart > CHAT_HIGHLIGHT_MAX_LINE_CHARS) return false;
    lineStart = i + 1;
    lines += 1;
    if (lines > CHAT_HIGHLIGHT_MAX_LINES) return false;
  }
  return code.length - lineStart <= CHAT_HIGHLIGHT_MAX_LINE_CHARS;
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
   * Strikethrough is `~~double-tilde~~` only (strict GFM). The micromark
   * default (`singleTilde: true`) also pairs bare `~`, and CJK prose uses a
   * bare tilde as a numeric range separator (`20~40 µm`) — two ranges in one
   * paragraph struck everything between them (F1, 2026-08-17 inspection).
   */
  remarkGfmOptions: { singleTilde: false } as const,
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
