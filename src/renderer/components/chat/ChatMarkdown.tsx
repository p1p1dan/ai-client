import { Image as ImageIcon } from 'lucide-react';
import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { CodeInline } from '@/components/ui/ident';
import { ChatCodeBlock } from './ChatCodeBlock';
import {
  chatMarkdownBlockquoteClass,
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
} from './chatMarkdown';

/**
 * T-29: assistant prose, rendered as Markdown.
 *
 * All policy — which protocols are linkable, which elements are inert, which
 * class each element gets — lives in `chatMarkdown.ts` so the node-only test
 * suite can assert it (F-C1…F-C5). This file is the wiring, plus the one thing
 * that cannot be a pure function: the component map itself.
 *
 * Read `chatMarkdown.ts`'s module note before changing anything here; the five
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
 * `__tests__/chatMarkdown.test.ts` scans this file's source for all three.
 */

/** Frozen at module scope: a new array identity per render would re-run the whole unified pipeline. */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Deliberately empty — see rule 1 above. Passed explicitly so it is a wiring fact, not a default. */
const REHYPE_PLUGINS: [] = [];

/**
 * `children` reduced to a plain string, for the code branches.
 *
 * A `<code>` element's children are a single text node in every markdown
 * construct that can produce one (inline spans cannot contain emphasis, and a
 * fence's body is opaque), so this is total in practice; `String()` keeps it
 * total in principle.
 */
function textOf(children: React.ReactNode): string {
  return typeof children === 'string' ? children : String(children ?? '');
}

const CHAT_MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h1 className={chatMarkdownHeadingClass(1)} {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className={chatMarkdownHeadingClass(2)} {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className={chatMarkdownHeadingClass(3)} {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className={chatMarkdownHeadingClass(4)} {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className={chatMarkdownHeadingClass(5)} {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className={chatMarkdownHeadingClass(6)} {...props} />,

  p: ({ node: _node, ...props }) => <p className={chatMarkdownParagraphClass()} {...props} />,
  ul: ({ node: _node, ...props }) => <ul className={chatMarkdownListClass(false)} {...props} />,
  ol: ({ node: _node, ...props }) => <ol className={chatMarkdownListClass(true)} {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className={chatMarkdownBlockquoteClass()} {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className={chatMarkdownHrClass()} {...props} />,

  table: ({ node: _node, ...props }) => (
    <div className={chatMarkdownTableWrapClass()}>
      <table className={chatMarkdownTableClass()} {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className={chatMarkdownTableCellClass('head')} {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className={chatMarkdownTableCellClass('body')} {...props} />
  ),

  /**
   * GFM task-list checkbox. Re-declared instead of inherited so "inert" is
   * OUR guarantee rather than `remark-gfm`'s default: nothing is spread from
   * the parsed node, and `disabled` + `readOnly` are set unconditionally.
   */
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked === true}
      disabled
      readOnly
      className="mr-1 align-middle"
    />
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
   */
  a: ({ node: _node, href, children, ...props }) => {
    const safe = sanitizeMarkdownHref(href);
    if (!safe) return <>{children}</>;
    return (
      <a
        className={chatMarkdownLinkClass()}
        href={safe}
        title={safe}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void window.electronAPI.shell.openExternal(safe);
        }}
        {...props}
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
    if (isFencedCodeBlock({ className, text })) {
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
