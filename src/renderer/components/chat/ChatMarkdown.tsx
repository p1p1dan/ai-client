import { Image as ImageIcon } from 'lucide-react';
import { isValidElement, memo } from 'react';
import Markdown, { type Components, type Options as MarkdownOptions } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeInline } from '@/components/ui/ident';
import { cn } from '@/lib/utils';
import { ChatCodeBlock } from './ChatCodeBlock';
import {
  chatMarkdownBlockquoteClass,
  chatMarkdownFootnotesClass,
  chatMarkdownHeadingClass,
  chatMarkdownHrClass,
  chatMarkdownImagePlaceholderClass,
  chatMarkdownLinkClass,
  chatMarkdownListClass,
  chatMarkdownParagraphClass,
  chatMarkdownRootClass,
  chatMarkdownTableCellClass,
  chatMarkdownTableClass,
  chatMarkdownTableWrapClass,
  chatMarkdownUrlTransform,
  codeLanguageFromClassName,
  isFencedCodeBlock,
  sanitizeMarkdownHref,
} from './chatMarkdownPolicy';

/**
 * T-29: assistant prose, rendered as Markdown.
 *
 * All policy — which protocols are linkable, which elements are inert, which
 * class each element gets — lives in `chatMarkdownPolicy.ts` so the node-only test
 * suite can assert it (F-C1…F-C5). This file is the wiring, plus the one thing
 * that cannot be a pure function: the component map itself.
 *
 * Read `chatMarkdownPolicy.ts`'s module note before changing anything here; the five
 * security rules and the reason chat does NOT reuse `files/MarkdownPreview.tsx`
 * are stated there in full.
 *
 * ## The three things this file must never grow
 *
 *  1. a `rehypePlugins` entry — `rehype-raw` is installed, and it is the one
 *     plugin that turns model-authored HTML into live DOM. The empty array is
 *     passed EXPLICITLY (rather than left to the default) so that adding one is
 *     a visible edit against an asserted constant;
 *  2. an element that carries a URL to the network (`img`, `iframe`, `video`,
 *     `source`, a `style` with `url()`);
 *  3. `dangerouslySetInnerHTML`.
 *
 * `__tests__/chatMarkdownPolicy.test.ts` scans this file's source for all three.
 *
 * ## Why every renderer spreads `props` FIRST
 *
 * `react-markdown` hands each renderer the parsed node's own properties, and
 * `remark-gfm` really does set some: a task list arrives as `className:
 * 'contains-task-list'`, a footnote heading as `className: 'sr-only'`, a link as
 * `title` from `[text](url "title")`. Spreading LAST let every one of those
 * overwrite the attribute this file had just hardened — measured, not theorised:
 * a task list rendered as `<ul class="contains-task-list">` with the whole policy
 * class gone, and `[x](https://evil "https://github.com/…")` showed the trusted
 * string in the tooltip while pointing elsewhere.
 *
 * So: `{...props}` goes first, every policy-owned attribute after it, and
 * `className` is MERGED through `cn` rather than replaced — `remark-gfm`'s hook
 * classes carry meaning (`sr-only` hides the footnote label; `.task-list-item`
 * is what the list class keys its marker suppression off) and dropping them
 * would trade one silent regression for another.
 */

/**
 * Hoisted to module scope so the prop identity is stable across renders.
 *
 * It does NOT stop the pipeline from re-running, and an earlier version of this
 * comment claimed it did: `react-markdown` v10 rebuilds its processor and
 * re-runs `parse` + `runSync` on every render regardless of whether the plugin
 * array is the same object. The thing that actually keeps the pipeline off the
 * one-second turn clock is the `memo` at the bottom of this file.
 */
/**
 * `singleTilde: false`: GFM proper only strikes `~~text~~`. The micromark
 * default additionally pairs single tildes, and CJK technical prose uses a
 * bare `~` as a range separator (`20~40 µm`) — two ranges in one paragraph
 * would strike everything between them (F1, 2026-08-17 inspection).
 */
const REMARK_PLUGINS: NonNullable<MarkdownOptions['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
  // FB9: block math only. `singleDollarTextMath: false` stops a single `$` from
  // opening inline math, and this app's core content is shell commands — `$PATH`,
  // `$HOME`, `$5`, template strings and regexes are all ordinary text here, and
  // the model's output is not ours to escape. Users asked for `$$…$$`; inline is
  // a separate decision that can be made later on real data (widening a rule is
  // safe, narrowing one takes formatting away from someone).
  [remarkMath, { singleDollarTextMath: false }],
];

/**
 * FB9: exactly one rehype plugin, and its options are the security surface.
 *
 * `output: 'mathml'` is load-bearing, not a preference: KaTeX's HTML output
 * ships its own `@font-face` declarations and `.woff2` files, and this repo has
 * a standing red line against bundled webfonts (`globals.css`: "no @font-face
 * and no font assets"). Measured before this landed — importing
 * `katex/dist/katex.min.css` takes the produced CSS from 24.7KB to 1.46MB with
 * 60 font files inlined. MathML is rendered natively by Chromium and needs
 * none of it.
 *
 * `trust` and `macros` are the two options with a known XSS surface (`trust`
 * enables `\href` / `\url` / `\includegraphics`; `macros` accepts injected
 * definitions). Neither is passed, and neither may be added — asserted in
 * `chatMarkdownPolicy.test.ts` and attacked directly in
 * `chatMarkdownRender.test.ts`.
 *
 * `throwOnError: false` keeps a malformed formula from taking the whole message
 * down; KaTeX renders its own error text rather than echoing the source as HTML.
 */
const REHYPE_PLUGINS: NonNullable<MarkdownOptions['rehypePlugins']> = [
  [rehypeKatex, { output: 'mathml', throwOnError: false, strict: 'ignore' }],
];

/**
 * `children` reduced to a plain string, for the code branches.
 *
 * A `<code>` element's children are a single text node in every markdown
 * construct that can produce one (inline spans cannot contain emphasis, and a
 * fence's body is opaque), so the string branch is what actually runs. The
 * other branches exist so the function is total over its declared
 * `React.ReactNode` rather than only over today's inputs — each one was a way
 * to silently CORRUPT displayed code:
 *
 *  - `String(['a','b'])` is `'a,b'`, splicing commas into the code the day a
 *    plugin splits that text node;
 *  - `String(<em/>)` is the literal `'[object Object]'`. Measured, not
 *    theorised: rendering `<code>{<strong>text</strong>}</code>` through the
 *    real pipeline returned exactly that. Recursing through `props.children`
 *    keeps the code text instead, at the cost of dropping the emphasis — which
 *    is the right trade inside a code span.
 */
function textOf(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map((child) => textOf(child)).join('');
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode };
    return textOf(props.children);
  }
  return String(children);
}

/**
 * Whether a rejected `<a>` is GFM's footnote RETURN arrow.
 *
 * `remark-gfm` marks it with the (oddly named, but real) class
 * `data-footnote-backref` plus a matching data attribute. Both are checked, and
 * `className` is accepted as a string or an array, so this does not depend on
 * which shape the current `react-markdown` / `hast` pair happens to hand over.
 */
function isFootnoteBackref(props: Record<string, unknown>): boolean {
  if ('data-footnote-backref' in props) return true;
  const className = props.className;
  if (typeof className === 'string')
    return className.split(/\s+/).includes('data-footnote-backref');
  if (Array.isArray(className)) return className.includes('data-footnote-backref');
  return false;
}

const CHAT_MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, className, ...props }) => (
    <h1 {...props} className={cn(chatMarkdownHeadingClass(1), className)} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2 {...props} className={cn(chatMarkdownHeadingClass(2), className)} />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 {...props} className={cn(chatMarkdownHeadingClass(3), className)} />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 {...props} className={cn(chatMarkdownHeadingClass(4), className)} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5 {...props} className={cn(chatMarkdownHeadingClass(5), className)} />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6 {...props} className={cn(chatMarkdownHeadingClass(6), className)} />
  ),

  p: ({ node: _node, className, ...props }) => (
    <p {...props} className={cn(chatMarkdownParagraphClass(), className)} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul {...props} className={cn(chatMarkdownListClass(false), className)} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol {...props} className={cn(chatMarkdownListClass(true), className)} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote {...props} className={cn(chatMarkdownBlockquoteClass(), className)} />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr {...props} className={cn(chatMarkdownHrClass(), className)} />
  ),

  table: ({ node: _node, className, ...props }) => (
    <div className={chatMarkdownTableWrapClass()}>
      <table {...props} className={cn(chatMarkdownTableClass(), className)} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th {...props} className={cn(chatMarkdownTableCellClass('head'), className)} />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td {...props} className={cn(chatMarkdownTableCellClass('body'), className)} />
  ),

  /**
   * GFM task-list checkbox. Re-declared instead of inherited so "inert" is
   * OUR guarantee rather than `remark-gfm`'s default: nothing is spread from
   * the parsed node, and `disabled` + `readOnly` are set unconditionally. This
   * is the one renderer that does NOT spread `props`, and that asymmetry is the
   * point — an `<input>` is the only element here with its own behaviour, so
   * "inherit nothing" is worth more than class fidelity.
   */
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked === true}
      disabled
      readOnly
      // `size-3.5` because the UA's default box is sized for a form, not for a
      // 15px prose line; `accent-primary` because without it Chromium paints
      // the native LIGHT appearance on the dark Flexoki surface — this window
      // declares no `color-scheme` anywhere, so the control would be the one
      // element in an audited surface whose colour comes from outside the
      // palette. (A root-level `color-scheme` would fix every native control in
      // the app at once and is the better fix; it is also app-wide, so it is
      // filed rather than smuggled in here.)
      className="mr-1 size-3.5 accent-primary align-middle"
    />
  ),

  /**
   * The GFM footnote block at the end of a reply.
   *
   * `remark-gfm` emits it as `<section data-footnotes class="footnotes">` with
   * an `<h2 class="sr-only">` label, and both classes are load-bearing — hence
   * the merge rather than a replace. What is added is the separation: without a
   * rule the footnote list butts straight against the last paragraph and reads
   * as one more list item. The `sr-only` heading is left to the merged class,
   * because `h2` would otherwise give it a visible section-break gap for a
   * heading nobody can see.
   */
  section: ({ node: _node, className, ...props }) => (
    <section {...props} className={cn(chatMarkdownFootnotesClass(className), className)} />
  ),

  /**
   * Security rule 2. A rejected href does not become a dead link, an empty
   * `href` or a `#` — the label is emitted as PLAIN TEXT, so `[click](javascript:…)`
   * reads as the words the model wrote and has nothing clickable on it.
   *
   * The accepted case does not navigate this window either: `preventDefault`
   * plus `shell.openExternal` is the repo's established route for an outbound
   * link, and the URL handed over is `sanitizeMarkdownHref`'s re-serialised
   * output (the preload does NOT re-check the protocol — see that function).
   * `target`/`rel` cover the middle-click path, which never reaches `onClick`
   * and instead lands on `MainWindow`'s `setWindowOpenHandler`, itself an
   * http(s) allow-list.
   *
   * `title` is the destination and is NOT overridable. Markdown's own
   * `[text](url "title")` syntax puts an author-controlled string in exactly the
   * attribute a user hovers to check where a link goes, so honouring it would
   * hand the model a tooltip that says `https://github.com/anthropics` over a
   * link to anywhere. It is dropped from `props` rather than merged.
   *
   * ## GFM footnotes degrade, deliberately
   *
   * `remark-gfm` wires footnotes with SAME-DOCUMENT fragment hrefs
   * (`#user-content-fn-1`), which are relative and therefore rejected by rule 2
   * — so a `[^1]` reference renders as a plain `1` and its body still appears in
   * the footnote section at the end. That is the correct trade: making them work
   * means either an in-app fragment-navigation primitive this window does not
   * have, or punching a hole in the allow-list for a URL shape the model also
   * controls. The one thing suppressed is the return arrow, which is a bare `↩`
   * once unlinked and means nothing without the jump behind it.
   */
  a: ({ node: _node, href, children, title: _title, ...props }) => {
    const safe = sanitizeMarkdownHref(href);
    if (!safe) {
      if (isFootnoteBackref(props)) return null;
      return <>{children}</>;
    }
    return (
      <a
        {...props}
        className={cn(chatMarkdownLinkClass(), props.className)}
        href={safe}
        title={safe}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void window.electronAPI.shell.openExternal(safe);
        }}
      >
        {children}
      </a>
    );
  },

  /**
   * Security rule 3: no `<img>` is ever constructed, so no `src` is ever
   * resolved and no request is ever issued. The alt text is kept because it is
   * the only part of `![alt](url)` that carries meaning for the reader — and it
   * is a text child, so it is escaped like any other prose.
   */
  img: ({ alt }) => (
    <span className={chatMarkdownImagePlaceholderClass()}>
      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      {alt ? <span className="min-w-0 truncate">{alt}</span> : null}
    </span>
  ),

  /**
   * `pre` is a pass-through and the `<pre>` element is emitted by
   * `ChatCodeBlock` instead — the block/inline decision needs the `language-*`
   * class, which only reaches the `code` renderer (`react-markdown` v10 dropped
   * the `inline` prop). Same shape `files/MarkdownPreview.tsx` uses.
   */
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children }) => {
    const text = textOf(children);
    if (isFencedCodeBlock({ className, text, hasChildren: children !== undefined })) {
      return (
        <ChatCodeBlock
          code={text.replace(/\n$/, '')}
          language={codeLanguageFromClassName(className)}
        />
      );
    }
    // D25 §2.5: the single inline-code primitive, so the mono / 13px / tracking
    // triple has exactly one place to be tuned (and this file stays off the A1
    // `font-mono` whitelist).
    return <CodeInline>{children}</CodeInline>;
  },
};

/**
 * `memo` is load-bearing, not a micro-optimisation.
 *
 * The turn head runs off a one-second clock, and `TurnItemView` is not itself
 * memoised — so without this, every completed paragraph in the in-flight turn
 * would re-run the full remark/rehype pipeline once a second for the whole
 * length of the reply. `text` is the only prop, so the comparison is exact.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className={chatMarkdownRootClass()}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={chatMarkdownUrlTransform}
        components={CHAT_MARKDOWN_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  );
});
