/**
 * D25 §2.4/§2.5 tool-row arg font-domain tests: `toolRowArgClass`'s three
 * branches (ident / prose / failed-color-preserved), plus a static-source
 * guard that ToolRows.tsx's two `<pre>` output bodies carry `font-mono`
 * (D25 §2.1 M3a/M3b -- without it, CLI tables/trees/diffs and structured
 * JSON input silently lose column alignment once the UI stack turns
 * proportional).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolRowArgClass } from '../toolCard';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('toolRowArgClass', () => {
  it('adds the mono primitive classes when argKind is "ident"', () => {
    const cls = toolRowArgClass({ failed: false, argKind: 'ident' });
    expect(cls).toContain('font-mono');
    expect(cls).toContain('text-code');
    expect(cls).toContain('tracking-normal');
  });

  it('adds no font-family class when argKind is "prose" or missing (sans default)', () => {
    const prose = toolRowArgClass({ failed: false, argKind: 'prose' });
    expect(prose).not.toContain('font-mono');
    const missing = toolRowArgClass({ failed: false, argKind: undefined });
    expect(missing).not.toContain('font-mono');
  });

  it('D25 §5.4: the prose branch carries tabular-nums (in-place refreshing counts must not jitter)', () => {
    const prose = toolRowArgClass({ failed: false, argKind: 'prose' });
    expect(prose).toContain('tabular-nums');
    const missing = toolRowArgClass({ failed: false, argKind: undefined });
    expect(missing).toContain('tabular-nums');
    // The ident branch is paths/URLs/commands, not refreshing counters --
    // no tabular-nums needed there.
    const ident = toolRowArgClass({ failed: false, argKind: 'ident' });
    expect(ident).not.toContain('tabular-nums');
  });

  it('preserves the failed-state destructive color independently of argKind', () => {
    const failedIdent = toolRowArgClass({ failed: true, argKind: 'ident' });
    expect(failedIdent).toContain('font-mono');
    expect(failedIdent).toContain('destructive');
    expect(failedIdent).not.toContain('text-tool-arg');

    const failedProse = toolRowArgClass({ failed: true, argKind: 'prose' });
    expect(failedProse).not.toContain('font-mono');
    expect(failedProse).toContain('destructive');
  });
});

describe('ToolRows.tsx <pre> bodies carry font-mono (D25 §2.1 M3a/M3b, static source guard)', () => {
  const source = readFileSync(path.join(__dirname, '..', 'ToolRows.tsx'), 'utf8');

  // `select-text` in the string: `globals.css` sets `user-select: none` on `*`,
  // and tool IN/OUT transcripts are content the operator copies from (T-29 GUI
  // review) — so the opt-in class is part of the pinned string, not noise.
  it('the structured-input <pre> (ToolRowInputSegment) has font-mono ahead of text-code', () => {
    expect(source).toMatch(
      /'m-0 select-text overflow-auto whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-\[1\.55\] text-muted-foreground'/
    );
  });

  it('the raw-output <pre> (ToolRowOutputSegment, body === "output") has font-mono ahead of text-code', () => {
    const preClassMatches = source.match(
      /m-0 select-text overflow-auto whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-\[1\.55\] text-muted-foreground/g
    );
    // Both the input segment and the output segment share the exact same
    // class string -- there must be exactly two occurrences.
    expect(preClassMatches).toHaveLength(2);
  });
});

describe('[FB7-7] the decision badge renders as bare inherited text (D24, static source guard)', () => {
  const source = readFileSync(path.join(__dirname, '..', 'ToolRows.tsx'), 'utf8');
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = stripped.indexOf('function ToolRowPermission');
  const body = stripped.slice(start, stripped.indexOf('\n}', start));

  it('exists and is rendered from the row content, not bolted on elsewhere', () => {
    expect(start).toBeGreaterThan(-1);
    expect(stripped).toContain('<ToolRowPermission view={view} />');
  });

  /**
   * The badge takes its colour from the row: `text-destructive` on a denied or
   * failed row, `text-muted-foreground` otherwise. Naming a colour here would
   * mean a grey word inside a red row (or a red one inside a grey row), and
   * naming the SAME colour in both cases is exactly that bug — so the component
   * names none, and reads its classes from the two assemblers instead.
   */
  it('names no colour, no background, no border, and no icon of its own', () => {
    expect(body).toContain('toolRowPermissionClass()');
    expect(body).toContain('toolRowPermissionNoteClass()');
    expect(body).not.toMatch(/\btext-(?!markdown\b)/);
    expect(body).not.toMatch(/\bbg-/);
    expect(body).not.toMatch(/border/);
    expect(body).not.toMatch(/Icon|Chevron|lucide/);
  });
});
