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
