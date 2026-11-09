import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DockCard, DockCardFooter, DockCardHeader, DockCardTitle } from '../dock-card';
import { type RunStatus, StatusIcon } from '../status-icon';

/** Design system v2 §6, §7.6: the shared status glyph and docked-card shell. */
describe('StatusIcon', () => {
  const statuses: RunStatus[] = ['running', 'waiting', 'success', 'failed', 'stopped', 'idle'];

  it.each(statuses)('draws "%s" in one 14px slot', (status) => {
    const html = renderToStaticMarkup(h(StatusIcon, { status }));
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('size-3.5');
  });

  it('running is neutral, never the info blue', () => {
    const html = renderToStaticMarkup(h(StatusIcon, { status: 'running' }));
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toMatch(/text-(info|status-running)/);
  });

  it('waiting is the clay breathing dot', () => {
    expect(renderToStaticMarkup(h(StatusIcon, { status: 'waiting' }))).toMatch(
      /animate-breathe[^"]*bg-primary/
    );
  });

  it('is hidden from assistive tech unless it is given a label', () => {
    expect(renderToStaticMarkup(h(StatusIcon, { status: 'failed' }))).toContain(
      'aria-hidden="true"'
    );
    const labelled = renderToStaticMarkup(h(StatusIcon, { label: 'Failed', status: 'failed' }));
    expect(labelled).toContain('aria-label="Failed"');
    expect(labelled).toContain('role="img"');
  });

  describe('decision 208: the bullet shape', () => {
    const bullet = (status: RunStatus) =>
      renderToStaticMarkup(h(StatusIcon, { shape: 'bullet', status }));

    it.each(statuses)('draws "%s" as a pseudo-element dot with no text of its own', (status) => {
      const html = bullet(status);
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain('data-shape="bullet"');
      // The quotes come out entity-escaped from the static renderer.
      expect(html).toMatch(/before:content-\[(?:'|&#x27;)●(?:'|&#x27;)\]/);
      // Never a glyph inside: copied and searched text must not pick it up.
      expect(html).toMatch(/<span[^>]*><\/span>$/);
      expect(html).toContain('aria-hidden="true"');
    });

    it('colours: success green, failed red, running neutral and blinking', () => {
      expect(bullet('success')).toContain('text-success');
      expect(bullet('failed')).toContain('text-destructive');
      const running = bullet('running');
      expect(running).toContain('text-foreground-faint');
      expect(running).toContain('animate-blink');
      expect(running).toContain('motion-reduce:animate-none');
      expect(running).not.toMatch(/text-(info|status-running)/);
    });
  });

  // Decision 208, second round (user ruling 2026-11-03): the terminal live
  // line's star, the CLI spinner's glyphs cycling on a pseudo-element.
  describe('decision 208: the star shape', () => {
    const star = (status: RunStatus) =>
      renderToStaticMarkup(h(StatusIcon, { shape: 'star', status }));

    it('running cycles in the brand ink and stops for reduced motion; no glyph of its own', () => {
      const html = star('running');
      expect(html).toContain('data-shape="star"');
      expect(html).toMatch(/before:content-\[(?:'|&#x27;)✻(?:'|&#x27;)\]/);
      expect(html).toContain('text-primary');
      expect(html).toContain('before:animate-star');
      expect(html).toContain('motion-reduce:before:animate-none');
      expect(html).toMatch(/<span[^>]*><\/span>$/);
    });

    it('a settled star does not move', () => {
      expect(star('success')).not.toContain('animate-star');
    });
  });
});

describe('DockCard', () => {
  it('tints only the border for pending and risk', () => {
    expect(renderToStaticMarkup(h(DockCard, { tone: 'pending' }))).toContain('border-primary/45');
    expect(renderToStaticMarkup(h(DockCard, { tone: 'risk' }))).toContain('border-destructive/45');
    expect(renderToStaticMarkup(h(DockCard))).toContain('border-border-soft');
  });

  it('a strip drops the elevation; a card keeps it', () => {
    expect(renderToStaticMarkup(h(DockCard))).toContain('elev-sm');
    expect(renderToStaticMarkup(h(DockCard, { kind: 'strip' }))).not.toContain('elev-sm');
  });

  it('head is 32px; footer actions sit right after a hairline', () => {
    const html = renderToStaticMarkup(
      h(
        DockCard,
        null,
        h(DockCardHeader, null, h(DockCardTitle, null, 'Run this?')),
        h(DockCardFooter)
      )
    );
    expect(html).toContain('h-8');
    expect(html).toMatch(/justify-end[^"]*border-t/);
  });
});
