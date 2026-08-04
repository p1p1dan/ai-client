import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Components } from 'react-markdown';
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

/**
 * The markdown ROOT's class list — anchored to the start of the output, which
 * is always the root `<div>`.
 *
 * Deliberately not `classOf(html, 'div')`: that finds the first div that HAS a
 * class, so on a document containing a table it would happily return the table
 * wrapper's class once the root's own class had been deleted. Anchoring makes
 * "the root lost its class" an empty string, which fails a positive assertion
 * instead of quietly satisfying a negative one.
 */
function rootClassOf(html: string): string {
  return /^<div\b[^>]*?\sclass="([^"]*)"/.exec(html)?.[1] ?? '';
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

// ---------------------------------------------------------------------------
// F-C6f: the positive half — what the root and the wrappers must CARRY
// ---------------------------------------------------------------------------

/**
 * The four assertions above are all negative, and a negative assertion over a
 * class list is vacuous the moment the class list is empty. Measured: deleting
 * every class from the markdown root leaves the whole of this file green, and
 * so does deleting the table's scroll wrapper or unplugging `remark-breaks`.
 * Each of those is a visible regression in the reading column, so each gets a
 * positive assertion here.
 */
describe('F-C6: the reading column’s own invariants are asserted, not only its prohibitions', () => {
  it('F-C6: the markdown root carries its class, not merely the absence of banned ones', () => {
    const root = rootClassOf(render('# heading\n\ntext\n'));
    // `min-w-0` is the one that keeps a long code line or a long URL from
    // widening this flex item and, through it, the whole reading column: a flex
    // child's `min-width` is `auto`, so without it the item refuses to shrink
    // below its content and `overflow-x-auto` on the leaf never gets to act.
    expect(root).toContain('min-w-0');
    // The other half of the same job, for prose with no break opportunity.
    expect(root).toContain('break-words');
    // D25's 15px body tier and its line height, pinned explicitly rather than
    // inherited — the same reason every heading spells `text-markdown`.
    expect(root).toContain('text-markdown');
    expect(root).toContain('leading-normal');
    expect(root).toContain('text-foreground');
    // `whitespace-pre-wrap` is the PRE-T-29 plain-text renderer's class and must
    // not come back: on top of `remark-breaks` it doubles every blank line.
    expect(root).not.toContain('whitespace-pre');
  });

  it('F-C6: a single newline is still a line break, so remark-breaks is still wired', () => {
    const html = render('line one\nline two\n');
    // Chat's own convention, and the reason the root can drop `whitespace-pre-wrap`.
    expect(html).toContain('<br/>');
    // One paragraph, not two: this is a break inside a block, not a block split.
    expect(html.match(/<p\b/g) ?? []).toHaveLength(1);
  });

  it('F-C6: a wide table scrolls inside its own wrapper, never on the root', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |\n');
    // The wrapper is the element IMMEDIATELY around the table, and it is the one
    // carrying the scroll. Anchoring the match to `<table` is what makes this
    // fail when the wrapper is deleted: the root div would then sit in that
    // position, and the root is asserted below to carry no `overflow-`.
    expect(html).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table\b/);
    expect(rootClassOf(html)).not.toContain('overflow-');
  });

  it('F-C6: a fenced block scrolls inside its own box, never on the root', () => {
    const html = render('```js\nconst averyveryverylongidentifier = 1\n```\n');
    expect(classOf(html, 'pre')).toContain('overflow-x-auto');
    expect(rootClassOf(html)).not.toContain('overflow-');
  });

  it('F-C6: the image chip truncates rather than widening the column', () => {
    const html = render(`![${'alt '.repeat(60)}](https://evil.example/x.png)`);
    // Second `min-w-0` site on this path: the chip is `inline-flex`, so its text
    // child needs the same escape from `min-width: auto` before `truncate` can
    // do anything.
    expect(html).toContain('min-w-0');
    expect(html).toContain('truncate');
    expect(classOf(html, 'span')).toContain('max-w-full');
  });
});

// ---------------------------------------------------------------------------
// F-C6g: the three behaviours changed in the T-29 hardening pass
// ---------------------------------------------------------------------------

describe('F-C6: the hardening pass changed three renderings, and these are they', () => {
  /**
   * A fence opened and closed with nothing between it has neither a language
   * nor a newline in its body, and `react-markdown` hands the renderer
   * `children === undefined`. It used to fall through to the inline branch and
   * render as an empty `CodeInline` chip — a stray grey pill in the prose with
   * no block spacing.
   */
  it('F-C6: an empty fence is a code BLOCK, not an empty inline chip', () => {
    const html = render('```\n```\n');
    expect(classOf(html, 'pre')).toContain('overflow-x-auto');
    expect(classOf(html, 'pre')).toContain('text-code');
    expect(html).toContain('<code></code>');
    expect(html).not.toContain('data-slot="code-inline"');
  });

  it('F-C6: a real inline span is still inline, so the empty-fence rule is narrow', () => {
    const html = render('a `x` b');
    expect(html).toContain('data-slot="code-inline"');
    expect(html).not.toContain('<pre');
  });

  it('F-C6: the task-list checkbox is sized for prose and painted from the palette', () => {
    const html = render('- [x] done\n');
    const input = classOf(html, 'input');
    // The UA default box is sized for a form, not for a 15px prose line.
    expect(input).toContain('size-3.5');
    // Without `accent-primary` Chromium paints the native LIGHT control on the
    // dark surface — the one element whose colour comes from outside the palette.
    expect(input).toContain('accent-primary');
    expect(input).toContain('align-middle');
    // The inert guarantee is unchanged by the restyle.
    expect(html).toContain('disabled=""');
    expect(html).toContain('readOnly=""');
    expect(attrOf(html, 'input', 'type')).toBe('checkbox');
  });

  it('F-C6: link hover moves the underline, not the text colour', () => {
    const cls = classOf(render('[x](https://example.com/a)'), 'a');
    expect(cls).toContain('underline');
    expect(cls).toContain('decoration-primary/40');
    expect(cls).toContain('hover:decoration-primary');
    // `hover:text-primary/80` measured 3.39:1 on light and 3.93:1 on dark,
    // i.e. under WCAG AA's 4.5:1 for body text in BOTH themes — a hover state
    // nobody can read is not a hover state.
    expect(cls).not.toContain('hover:text-primary/80');
  });
});

// ---------------------------------------------------------------------------
// F-C6h: the code renderer's children handling, including the branch markdown
//        cannot reach
// ---------------------------------------------------------------------------

/**
 * The real component map, taken out of the real element tree.
 *
 * `ChatMarkdown` is `memo(fn)` over a body that uses no hooks, so calling `fn`
 * gives back the `<div><Markdown …/></div>` element and, with it, the props the
 * component actually passes. No mock and no module-registry games: the closures
 * exercised below are the ones that ship.
 *
 * It exists for one branch that markdown source cannot reach. `textOf` handles
 * a React ELEMENT child by recursing into `props.children`; without that branch
 * `String(<strong/>)` is the literal `'[object Object]'`, rendered AS the code.
 * No input produces that shape today — mdast's `inlineCode` is a literal node
 * with a `value` rather than children, so neither `remark-gfm` nor
 * `remark-breaks` can split it, and with `rehypePlugins` empty nothing
 * downstream can either. The branch is therefore defence against a future
 * plugin, and handing the renderer the shape directly is the only honest way to
 * assert it rather than to assume it.
 */
function chatMarkdownWiring(): {
  components: Components;
  remarkPlugins: unknown[];
  rehypePlugins: unknown[];
  urlTransform: unknown;
} {
  const inner = (ChatMarkdown as unknown as { type: (props: { text: string }) => ReactElement })
    .type;
  const root = inner({ text: '' });
  const markdown = (root.props as { children: ReactElement }).children;
  return markdown.props as {
    components: Components;
    remarkPlugins: unknown[];
    rehypePlugins: unknown[];
    urlTransform: unknown;
  };
}

describe('F-C6: the code renderer reduces children to text, never stringifies a node', () => {
  it('F-C6: the map read out of the tree is the one the component passes', () => {
    // The vacuity guard for the two tests below: if this stops describing the
    // real wiring, they are exercising a closure nobody renders.
    const wiring = chatMarkdownWiring();
    expect(wiring.rehypePlugins).toEqual([]);
    expect(wiring.remarkPlugins).toHaveLength(2);
    expect(typeof wiring.urlTransform).toBe('function');
    expect(typeof wiring.components.code).toBe('function');
  });

  it('F-C6: an element child renders as its text, never as [object Object]', () => {
    const Code = chatMarkdownWiring().components.code as never;
    const html = renderToStaticMarkup(
      createElement(Code, {
        className: 'language-js',
        children: createElement('strong', null, 'const a = 1'),
      } as never)
    );
    expect(html).toContain('<code>const a = 1</code>');
    expect(html).not.toContain('[object Object]');
    // The emphasis is dropped rather than nested, which is the right trade
    // inside a code span — and it must not leak markup into the block either.
    expect(html).not.toContain('<strong');
  });

  it('F-C6: a split body is neither comma-spliced nor stringified', () => {
    const Code = chatMarkdownWiring().components.code as never;
    const html = renderToStaticMarkup(
      createElement(Code, {
        className: 'language-js',
        children: [createElement('em', null, 'const '), 'a = ', createElement('b', null, '1')],
      } as never)
    );
    // `String(['a','b'])` is `'a,b'` and `String(<em/>)` is `'[object Object]'`;
    // this input is the one shape that would hit both at once.
    expect(html).toContain('<code>const a = 1</code>');
    expect(html).not.toContain('[object Object]');
  });
});
