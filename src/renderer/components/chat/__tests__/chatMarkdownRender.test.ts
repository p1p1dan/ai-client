import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from '../ChatMarkdown';

/**
 * T-29 F-C6: the component map, asserted by RENDERING it.
 *
 * The rest of the suite is pure functions plus a static source scan, and that
 * pairing has one structural blind spot: a component map is a bag of closures,
 * so neither half can see what the closures actually emit. The bug that
 * motivated this file is exactly that shape — `{...props}` was spread AFTER the
 * hardened attributes, so `remark-gfm`'s own `className` silently replaced every
 * policy class on a task list, and a markdown link's `title` replaced the
 * destination the tooltip is supposed to show. Both files passed every existing
 * assertion.
 *
 * `renderToStaticMarkup` keeps this in the node environment the rest of the
 * suite runs in: no jsdom, no DOM globals, no act(). What it cannot cover is
 * anything asynchronous — `ChatCodeBlock` resolves shiki in an effect, so a
 * fenced block renders here in its un-highlighted first-paint form, which is the
 * state this file asserts (and the one that must already be correct, since it is
 * what the user sees for the first frame).
 */

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text: markdown }));
}

/** The class list of the first `<tag …>` in the output. */
function classOf(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*?\\sclass="([^"]*)"`).exec(html);
  return match?.[1] ?? '';
}

/** The value of `attr` on the first `<tag …>` in the output, or `null`. */
function attrOf(html: string, tag: string, attr: string): string | null {
  const el = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`\\s${attr}="([^"]*)"`).exec(el)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// F-C6a: plugin-supplied props cannot displace policy attributes
// ---------------------------------------------------------------------------

describe('F-C6: remark-gfm cannot overwrite what the policy sets', () => {
  /**
   * The regression this file exists for. `remark-gfm` sets `className:
   * 'contains-task-list'` on the `<ul>`, and the whole policy class string used
   * to vanish under it — no indent, no marker, no block gap.
   */
  it('F-C6: a task list keeps the policy class AND the plugin class', () => {
    const html = render('- [ ] alpha\n- [x] beta\n');
    const ul = classOf(html, 'ul');
    // The policy half — the same values the pure-function test pins.
    expect(ul).toContain('ml-5');
    expect(ul).toContain('list-disc');
    expect(ul).toContain('mt-2.5');
    // The plugin half, which the marker-suppression rule keys off.
    expect(ul).toContain('contains-task-list');
    expect(html).toContain('task-list-item');
  });

  it('F-C6: a plain list is unaffected, so the merge did not change the base case', () => {
    const ul = classOf(render('- alpha\n- beta\n'), 'ul');
    expect(ul).toContain('ml-5');
    expect(ul).toContain('list-disc');
    expect(ul).not.toContain('contains-task-list');
  });

  /**
   * `<ol start="5">` proves the spread still WORKS: reordering it must not turn
   * into "drop the parsed node's properties", which would silently renumber
   * every list that does not start at 1.
   */
  it('F-C6: an ordered list still honours its start attribute', () => {
    const html = render('5. five\n6. six\n');
    expect(attrOf(html, 'ol', 'start')).toBe('5');
    expect(classOf(html, 'ol')).toContain('list-decimal');
  });

  /** Same proof on a second axis: GFM column alignment is a `style`, not a class. */
  it('F-C6: table alignment survives, alongside the cell class', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |\n');
    expect(attrOf(html, 'th', 'style')).toContain('text-align:left');
    expect(classOf(html, 'th')).toContain('border-border');
    expect(classOf(html, 'table')).toContain('w-full');
  });
});

// ---------------------------------------------------------------------------
// F-C6b: the link is not spoofable
// ---------------------------------------------------------------------------

describe('F-C6: an assistant-authored link cannot lie about where it goes', () => {
  /**
   * Markdown's `[text](url "title")` puts an author-controlled string in the
   * exact attribute a user hovers to check a destination. It used to win.
   */
  it('F-C6: a markdown title cannot replace the destination in the tooltip', () => {
    const html = render('[click me](https://evil.example "https://github.com/anthropics")');
    expect(attrOf(html, 'a', 'href')).toBe('https://evil.example/');
    expect(attrOf(html, 'a', 'title')).toBe('https://evil.example/');
    expect(html).not.toContain('github.com/anthropics');
  });

  it('F-C6: with no title the tooltip is still the destination', () => {
    const html = render('[click me](https://evil.example)');
    expect(attrOf(html, 'a', 'title')).toBe('https://evil.example/');
  });

  it('F-C6: the hardened attributes are all present and are the policy values', () => {
    const html = render('[x](https://example.com/a)');
    expect(attrOf(html, 'a', 'target')).toBe('_blank');
    expect(attrOf(html, 'a', 'rel')).toBe('noopener noreferrer');
    expect(classOf(html, 'a')).toContain('text-primary');
  });

  it('F-C6: a rejected scheme renders as text with no anchor at all', () => {
    for (const md of [
      '[click](javascript:alert(1))',
      '[click](file:///etc/passwd)',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[click](./relative.md)',
    ]) {
      const html = render(md);
      expect(html, md).not.toContain('<a ');
      expect(html, md).toContain('click');
    }
  });

  it('F-C6: an autolinked bare url is sanitised on the same path', () => {
    const html = render('see https://example.com/x?a=1&b=2 ok');
    expect(attrOf(html, 'a', 'href')).toBe('https://example.com/x?a=1&amp;b=2');
    expect(attrOf(html, 'a', 'rel')).toBe('noopener noreferrer');
  });
});

// ---------------------------------------------------------------------------
// F-C6c: footnotes degrade cleanly
// ---------------------------------------------------------------------------

describe('F-C6: GFM footnotes degrade to text rather than to broken links', () => {
  /**
   * `remark-gfm` wires footnotes with same-document fragment hrefs, which rule 2
   * rejects. The body must still be readable and the dangling return arrow must
   * not be left behind.
   */
  it('F-C6: the reference and body survive, the dead backref arrow does not', () => {
    const html = render('text with a note[^1]\n\n[^1]: the note body\n');
    expect(html).toContain('the note body');
    expect(html).toContain('<sup>1</sup>');
    // No anchor anywhere: every footnote href is a rejected fragment.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('#user-content-fn-1');
    // The return arrow is meaningless once unlinked, so it is suppressed.
    expect(html).not.toContain('↩');
  });

  it('F-C6: the footnote section is separated and keeps its plugin classes', () => {
    const html = render('note[^1]\n\n[^1]: body\n');
    const section = classOf(html, 'section');
    expect(section).toContain('footnotes');
    expect(section).toContain('mt-5');
    // `sr-only` is what keeps the "Footnotes" label out of the visual flow.
    expect(classOf(html, 'h2')).toContain('sr-only');
  });
});

// ---------------------------------------------------------------------------
// F-C6d: the security rules, as rendered output
// ---------------------------------------------------------------------------

describe('F-C6: the five security rules hold in the emitted markup', () => {
  it('F-C6: raw HTML arrives escaped, not as markup', () => {
    const html = render('<script>alert(1)</script>\n\n<b>bold?</b>\n\n<img src="https://x/y.png">');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img');
  });

  it('F-C6: a markdown image is an inert chip carrying only the alt text', () => {
    const html = render('![the alt text](https://evil.example/beacon.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('beacon.png');
    expect(html).not.toContain('src=');
    expect(html).toContain('the alt text');
  });

  it('F-C6: the task-list checkbox is inert regardless of what the source says', () => {
    const html = render('- [x] done\n');
    expect(html).toContain('disabled');
    expect(html).toContain('readOnly');
    expect(attrOf(html, 'input', 'type')).toBe('checkbox');
  });

  it('F-C6: code text crosses as escaped text in both the inline and fenced shapes', () => {
    const inline = render('a `<script>alert(1)</script>` b');
    expect(inline).toContain('&lt;script&gt;');
    expect(inline).not.toContain('<script');

    const fenced = render('```html\n<script>alert(1)</script>\n```\n');
    expect(fenced).toContain('&lt;script&gt;');
    expect(fenced).not.toContain('<script');
    // First paint is the un-highlighted box, in the policy's own class.
    expect(classOf(fenced, 'pre')).toContain('overflow-x-auto');
    expect(classOf(fenced, 'pre')).toContain('text-code');
  });

  /**
   * `String(['a','b'])` is `'a,b'`. Today a `<code>` body is one text node, so
   * this asserts the property that must survive the day it is not.
   */
  it('F-C6: a fence body is never comma-spliced', () => {
    const html = render('```\nline one\nline two\n```\n');
    expect(html).toContain('line one');
    expect(html).not.toContain(',line two');
  });
});

// ---------------------------------------------------------------------------
// F-C6e: the block rhythm, as rendered
// ---------------------------------------------------------------------------

describe('F-C6: prose blocks carry their policy classes', () => {
  it('F-C6: headings render at the policy rank, not a UA size', () => {
    for (const [md, tag] of [
      ['# h1\n', 'h1'],
      ['## h2\n', 'h2'],
      ['###### h6\n', 'h6'],
    ] as const) {
      const cls = classOf(render(md), tag);
      expect(cls, tag).toContain('text-markdown');
    }
  });

  it('F-C6: blockquote, hr and paragraph all reach the DOM styled', () => {
    expect(classOf(render('> quoted\n'), 'blockquote')).toContain('border-l-2');
    expect(classOf(render('---\n'), 'hr')).toContain('border-border');
    expect(classOf(render('just prose\n'), 'p')).toContain('mt-2.5');
  });

  /**
   * The structural prohibition from F-C4, checked on the actual root element:
   * T-31's pinned user bubble is a plain `position: sticky`, and each of these
   * four properties either disables it or re-parents its containing block.
   */
  it('F-C6: the markdown root carries nothing that would break a sticky ancestor', () => {
    const root = classOf(render('# heading\n\ntext\n'), 'div');
    for (const banned of ['overflow-', 'transform', 'filter', 'contain-']) {
      expect(root, banned).not.toContain(banned);
    }
  });
});
