import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ReadingAnchor, readingAnchorShift } from '../readingAnchor';

/** Just enough of an Element for `readingAnchorShift`. */
function box(top: number, { connected = true, rendered = true } = {}) {
  return {
    isConnected: connected,
    getClientRects: () => (rendered ? [{}] : []),
    getBoundingClientRect: () => ({ top }),
  } as unknown as Element;
}

describe('readingAnchorShift (PiLab R1, FR-11.3)', () => {
  it('measures how far the anchored element moved', () => {
    const anchor: ReadingAnchor = { chain: [{ el: box(100), top: 256 }] };
    expect(readingAnchorShift(anchor)).toBe(-156);
  });

  it('falls back to the nearest ancestor with a box when the anchor folded away', () => {
    const anchor: ReadingAnchor = {
      chain: [
        { el: box(0, { rendered: false }), top: 200 }, // paragraph inside a group that just folded
        { el: box(0, { connected: false }), top: 180 }, // a wrapper React replaced
        { el: box(150), top: 120 }, // the turn section
      ],
    };
    expect(readingAnchorShift(anchor)).toBe(30);
  });

  it('is null when nothing in the chain can be measured', () => {
    expect(readingAnchorShift({ chain: [{ el: box(0, { rendered: false }), top: 1 }] })).toBeNull();
  });
});

describe('MessageTimeline wiring for the reading anchor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../MessageTimeline.tsx'), 'utf8');

  it('compensates only when not following and not for a click-driven disclosure', () => {
    expect(src).toMatch(
      /else if \(!disclosureResize && readingAnchorRef\.current\) \{[\s\S]{0,400}readingAnchorShift\(readingAnchorRef\.current\)[\s\S]{0,120}viewport\.scrollTop \+= shift/
    );
  });

  it('re-captures the anchor on scroll and after resize, and drops it when following resumes', () => {
    expect(src).toContain('captureReadingAnchor(viewport, contentRef.current)');
    expect(src).toContain('readingAnchorRef.current = captureReadingAnchor(viewport, content)');
    expect(src.match(/readingAnchorRef\.current = null;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('feeds the previous scrollTop and clientHeight to the follower (FR-11.1 rule 0)', () => {
    expect(src).toContain('prevScrollTop: lastScrollTopRef.current');
    expect(src).toContain('prevClientHeight: lastClientHeightRef.current');
  });
});

describe('[PILAB-R1-11.4 / 02.6] inner scroll boxes and reduced motion', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  it('tool output, live output and thought bodies keep their scroll to themselves', () => {
    const rows = read('ToolRows.tsx');
    expect(rows.match(/overflow-auto overscroll-contain/g)?.length).toBeGreaterThanOrEqual(4);
    expect(read('LiveToolOutput.tsx')).toContain('overflow-auto overscroll-contain');
    expect(read('chatTimelineLayout.ts')).toContain(
      "'max-h-[46vh] overflow-y-auto overscroll-contain'"
    );
  });

  it('an upward wheel stops following only when it scrolls the timeline itself', () => {
    expect(read('MessageTimeline.tsx')).toMatch(
      /if \(event\.deltaY >= 0\) return;\s*for \(let el = event\.target as Element \| null; el && el !== viewport; el = el\.parentElement\) \{\s*if \(el\.scrollTop > 0 && el\.scrollHeight > el\.clientHeight\) return;/
    );
  });

  it('chevrons and the prompt rail honour prefers-reduced-motion', () => {
    expect(
      read('MessageTimeline.tsx').match(/duration-150 motion-reduce:transition-none/g)
    ).toHaveLength(3);
    expect(read('PromptNavRail.tsx')).toContain("behavior: reduceMotion ? 'auto' : 'smooth'");
  });
});
