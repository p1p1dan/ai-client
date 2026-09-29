import { Fragment, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { chatMarkdownLinkClass, sanitizeMarkdownHref } from './chat/chatMarkdownPolicy';

/**
 * Release notes in the update dialog.
 *
 * Two shapes arrive, depending on the release:
 *
 * - **Markdown** — `latest.yml`'s `releaseNotes`, which electron-builder fills
 *   from `docs/release-notes/unreleased.md` (`releaseInfo.releaseNotesFile`).
 *   electron-updater prefers it over the feed, so every release from 1.0.4 on
 *   ships this shape.
 * - **HTML** — the GitHub feed entry, i.e. the release body already RENDERED
 *   (`<h2>`, `<ul><li>`, `<strong>`), used when `latest.yml` carries no notes.
 *   Printed as text it reads as a wall of tags.
 *
 * Both are network input, so neither reaches the DOM as markup. Markdown goes
 * through `react-markdown` with no `rehype-raw`, as in chat. HTML goes through
 * `DOMParser`, which builds an inert document (no script runs, nothing is
 * fetched); only the elements in {@link NOTE_ELEMENTS} are rebuilt as React
 * nodes and no attribute is ever copied across. Any other element keeps its
 * text; scripts, styles and embedded media are dropped whole. Links go
 * through the chat's http(s)-only gate and open in the system browser.
 */
export function ReleaseNotes({ notes, className }: { notes: string; className?: string }) {
  const html = useMemo(
    () => (looksLikeHtml(notes) ? renderReleaseNotesHtml(notes) : null),
    [notes]
  );
  return (
    <div className={cn('space-y-2', className)}>
      {html ?? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {notes}
        </ReactMarkdown>
      )}
    </div>
  );
}

/**
 * GitHub's rendered body always opens with a block element. Keyed on that, not
 * on "contains a tag": Markdown notes routinely carry things like `<userData>`.
 */
function looksLikeHtml(notes: string): boolean {
  return /^\s*<(?:h[1-6]|p|ul|ol|div|blockquote|pre|table|hr|details)[\s/>]/i.test(notes);
}

interface NoteProps {
  children?: ReactNode;
  href?: string;
}

const EMPHASIS_CLASS = 'font-semibold text-foreground';

function NoteHeading({ children }: NoteProps) {
  return <p className={EMPHASIS_CLASS}>{children}</p>;
}

function NoteLink({ children, href }: NoteProps) {
  const safe = sanitizeMarkdownHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      title={safe}
      className={chatMarkdownLinkClass()}
      onClick={(event) => {
        event.preventDefault();
        void window.electronAPI.shell.openExternal(safe);
      }}
    >
      {children}
    </a>
  );
}

/** The whitelist both shapes render through, so they look the same. */
const NOTE_ELEMENTS: Record<string, (props: NoteProps) => ReactNode> = {
  h1: NoteHeading,
  h2: NoteHeading,
  h3: NoteHeading,
  h4: NoteHeading,
  h5: NoteHeading,
  h6: NoteHeading,
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className={EMPHASIS_CLASS}>{children}</strong>,
  b: ({ children }) => <strong className={EMPHASIS_CLASS}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  i: ({ children }) => <em>{children}</em>,
  code: ({ children }) => <code className="rounded-xs bg-muted px-1 text-code">{children}</code>,
  // The block carries the code styling; the inline chip inside it steps back.
  pre: ({ children }) => (
    <pre className="overflow-auto rounded-sm bg-muted p-2 text-code *:bg-transparent *:px-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3">{children}</blockquote>
  ),
  br: () => <br />,
  hr: () => <hr className="border-border" />,
  a: NoteLink,
};

const MARKDOWN_COMPONENTS: Components = { ...NOTE_ELEMENTS, img: () => null };

/** Elements dropped together with their content: code, styling, or something that would fetch. */
const DROPPED_ELEMENTS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'img',
  'picture',
  'video',
  'audio',
  'svg',
  'math',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
]);

/** Containers whose whitespace-only text is markup formatting, not content. */
const BLOCK_CONTAINERS = new Set(['body', 'ul', 'ol', 'blockquote']);

function renderReleaseNotesHtml(html: string): ReactNode[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return renderChildren(doc.body, 'n');
}

function renderChildren(parent: Element, key: string): ReactNode[] {
  const block = BLOCK_CONTAINERS.has(parent.tagName.toLowerCase());
  const out: ReactNode[] = [];
  parent.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (!(block && text.trim() === '')) out.push(text);
      return;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      out.push(renderElement(child as Element, `${key}.${index}`));
    }
  });
  return out;
}

function renderElement(element: Element, key: string): ReactNode {
  const tag = element.tagName.toLowerCase();
  if (DROPPED_ELEMENTS.has(tag)) return null;
  const children = renderChildren(element, key);
  const Note = NOTE_ELEMENTS[tag];
  if (!Note) return <Fragment key={key}>{children}</Fragment>;
  const href = tag === 'a' ? (element.getAttribute('href') ?? undefined) : undefined;
  return (
    <Note key={key} href={href}>
      {children}
    </Note>
  );
}
