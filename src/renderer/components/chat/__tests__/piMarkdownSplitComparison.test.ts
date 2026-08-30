import { describe, expect, it } from 'vitest';
import { splitClosedPrefix } from '../chatMarkdownPolicy';

/**
 * T12-c — the measured comparison the roadmap asked for before deciding
 * whether to replace our streaming-Markdown split with pi-app's.
 *
 * ## Verdict: keep ours, but it is a TRADE-OFF, not a defect on their side
 *
 * An earlier version of this file called pi-app's splitter broken because it
 * commits a prefix ending inside an open ``` fence. That framing was wrong,
 * and the correction is worth keeping written down:
 *
 * **An unterminated fence is not an error.** CommonMark closes it at the end
 * of the document, so the committed half parses as a complete, correctly
 * highlighted `code` node — just a shorter one. Verified against the parser
 * this app actually uses (`mdast-util-from-markdown`):
 * `'…\n```ts\nfunction a() {\n  return 1;\n'` →
 * `[{type:'paragraph'}, {type:'code', lang:'ts', value:'function a() {\n  return 1;'}]`.
 *
 * So the real difference, measured by streaming a 15-line code block line by
 * line through both:
 *
 *  - For most of the stream the two behave IDENTICALLY — the whole fence sits
 *    in the plain tail on both sides.
 *  - pi-app pulls ahead only where the code contains a BLANK LINE (its
 *    `\n\n` rule), committing a partial, highlighted code block a few steps
 *    earlier. Without a blank line inside the fence it commits nothing extra
 *    either, because its other two rules cannot fire on code.
 *  - The price is a visible reflow: when the fence finally closes, lines that
 *    were plain text move INTO the code block and the block re-renders.
 *
 * ⇒ eager-with-reflow (theirs) vs late-but-stable (ours). Ours guarantees a
 * committed segment is never re-interpreted, and the guarantee is argued from
 * CommonMark in `chatMarkdownPolicy.ts`'s head note. Whether that guarantee is
 * worth showing a long code block as unhighlighted plain text for longer is a
 * PRODUCT judgement, not a correctness fact — so "keep ours" here means "no
 * sufficient reason to switch", not "theirs is broken".
 *
 * pi-app's algorithm is reproduced verbatim below as the reference under test.
 * It is MIT, and the point is to run it rather than to argue about it.
 */

/** Reference implementation: pi-app `splitStreamingMarkdown` (MIT). */
function piAppSplit(text: string): { committed: string; tail: string } {
  if (!text) return { committed: '', tail: '' };
  const minTail = 28;

  const paraIdx = text.lastIndexOf('\n\n');
  if (paraIdx >= 0 && text.length - (paraIdx + 2) >= minTail) {
    const cut = paraIdx + 2;
    return { committed: text.slice(0, cut), tail: text.slice(cut) };
  }

  const lineIdx = text.lastIndexOf('\n');
  if (lineIdx >= 0 && text.length - (lineIdx + 1) >= minTail * 2) {
    const cut = lineIdx + 1;
    return { committed: text.slice(0, cut), tail: text.slice(cut) };
  }

  let lastSentEnd = -1;
  const re = /[.!?。！？…]["')\]]*\s+/g;
  for (const m of text.matchAll(re)) {
    lastSentEnd = (m.index ?? 0) + m[0].length;
  }
  if (
    lastSentEnd > 0 &&
    text.length - lastSentEnd >= minTail &&
    lastSentEnd >= Math.min(80, text.length * 0.2)
  ) {
    return { committed: text.slice(0, lastSentEnd), tail: text.slice(lastSentEnd) };
  }
  return { committed: '', tail: text };
}

/** Streaming mid-fence: a blank line inside a code block, which is ordinary. */
const MID_FENCE = [
  'Here is the fix:',
  '',
  '```ts',
  'function a() {',
  '  return 1;',
  '',
  '  // still writing this function, the fence is not closed yet',
].join('\n');

function fenceMarkersIn(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

describe('streaming markdown split: ours vs pi-app', () => {
  it('pi-app commits a prefix that ends inside an open code fence', () => {
    const { committed } = piAppSplit(MID_FENCE);
    // It cut at the blank line INSIDE the code block, so the committed half
    // opens a fence it never closes.
    expect(committed).toContain('```ts');
    expect(fenceMarkersIn(committed) % 2).toBe(1);
    // NOT a broken render: CommonMark closes that fence at end of document, so
    // this parses as a complete (shorter) highlighted code block. The cost is
    // a reflow later, when the real closing fence arrives and those lines move
    // into the block. See the head note.
  });

  it('ours does not SETTLE an open fence, but does render it', () => {
    const { segments, openFence } = splitClosedPrefix(MID_FENCE);
    // Nothing settled can contain half a fence…
    expect(fenceMarkersIn(segments.join('\n')) % 2).toBe(0);
    // …but since T12-c (user decision: 按 pi-app 的来) the open fence is handed
    // to the parser instead of sitting as plain text for the whole stream.
    // Ours differs from pi-app's in ONE way that matters: the chunk carries its
    // own opening fence, so the block on screen only ever GAINS lines — where
    // pi-app's committed prefix has to be re-cut when the real closing fence
    // arrives, moving lines from plain text into the block.
    expect(openFence).toContain('```ts');
  });

  it('ours commits the fence as ONE whole segment once it closes', () => {
    const closedFence = `${MID_FENCE}\n}\n\`\`\`\n\nAnd that is the change.\n\n`;
    const { segments, openTail } = splitClosedPrefix(closedFence);

    // Two segments: the intro paragraph, then the entire code block. The blank
    // line inside the fence — the exact spot pi-app cuts at — did not split it.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe('Here is the fix:');
    expect(fenceMarkersIn(segments[1])).toBe(2);
    expect(segments[1]).toContain('  return 1;\n\n  // still writing this function');

    // The trailing paragraph stays open because the model may still be writing
    // it — that is the point of the open tail, not a missed commit.
    expect(openTail).toContain('And that is the change.');
  });

  it('behaves identically to pi-app for most of a streaming code block', () => {
    // The measurement that shrank the verdict from "ours is better" to "no
    // reason to switch": stream a real code block line by line and compare
    // how much each side has committed at every step.
    const full = [
      'Here is the fix:',
      '',
      '```ts',
      'export function greet(name: string) {',
      '  const trimmed = name.trim();',
      '  if (!trimmed) {',
      '    throw new Error("name is required");',
      '  }',
      '', // ← the ONLY place pi-app can get ahead: a blank line inside code
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code text, not a template
      '  console.log(`hello ${trimmed}`);',
      '  return trimmed.length;',
      '}',
      '```',
    ];

    const aheadAt: number[] = [];
    for (let lines = 3; lines <= full.length; lines += 1) {
      const partial = full.slice(0, lines).join('\n');
      const theirs = piAppSplit(partial).committed.length;
      const ours = splitClosedPrefix(partial).closedLength;
      if (theirs > ours) aheadAt.push(lines);
    }

    // Not "never" and not "always". Measured, not predicted — I expected this
    // to stop at 12 and it does not: step 13 is the closing fence line itself,
    // and OUR splitter still will not commit there, because it settles a block
    // on the blank line AFTER it, not on the fence. So pi-app leads for one
    // step longer than the "until the fence closes" story suggests.
    expect(aheadAt).toEqual([10, 11, 12, 13]);
  });

  it('gives pi-app no advantage when the code block has no blank line', () => {
    // Its `\n\n` rule is the only one that can fire inside code; the other two
    // need 56 free characters after a newline, or sentence punctuation.
    const noBlankLine = [
      'Here is the fix:',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
    ].join('\n');
    expect(piAppSplit(noBlankLine).committed.length).toBe(
      splitClosedPrefix(noBlankLine).closedLength
    );
  });

  it('grows the streaming code block by APPENDING only — no reflow', () => {
    // The property that made it worth adopting pi-app's goal without copying
    // its mechanism. Stream a fence line by line and check that each step's
    // rendered code block is a prefix of the next one: lines are only ever
    // added, never re-cut. pi-app's committed prefix cannot promise this —
    // when the closing fence lands, lines move from plain text into the block.
    const lines = ['```ts', 'const a = 1;', '', 'const b = 2;', 'const c = 3;'];
    const rendered: string[] = [];
    for (let n = 1; n <= lines.length; n += 1) {
      const partial = `intro\n\n${lines.slice(0, n).join('\n')}`;
      const { openFence } = splitClosedPrefix(partial);
      if (openFence) rendered.push(openFence);
    }

    expect(rendered.length).toBeGreaterThan(1);
    for (let i = 1; i < rendered.length; i += 1) {
      expect(rendered[i].startsWith(rendered[i - 1])).toBe(true);
    }
  });

  it('hands the closed fence back to the settled segments, unchanged', () => {
    // The handover has to be seamless: what `openFence` was showing must be
    // exactly what the settled segment shows, or the block jumps at the moment
    // it completes — the reflow this whole design avoids.
    const open = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;';
    const closed = `${open}\n\`\`\`\n\nafter\n\n`;

    const streaming = splitClosedPrefix(open).openFence;
    const settled = splitClosedPrefix(closed).segments.find((s) => s.includes('```ts'));

    expect(streaming).toBeDefined();
    expect(settled).toBeDefined();
    // Same code, same order; the settled form only adds the closing fence.
    expect(settled).toBe(`${streaming?.replace(/\n+$/, '')}\n\`\`\``);
  });

  it('leaves a non-fence tail as plain text, exactly as before', () => {
    // The change is scoped to fences. In-flight PROSE can still be
    // reinterpreted by what comes next, so it must not reach the parser.
    const { openTail, openFence } = splitClosedPrefix('done\n\nstill writing this sentence');
    expect(openTail).toBe('still writing this sentence');
    expect(openFence).toBeUndefined();
  });

  it('keeps in-flight prose OUT of the parsed chunk when a fence follows it', () => {
    // Caught by mutation testing, not by design: making `openFence` swallow the
    // whole tail passed every other assertion here. It must not — the prose
    // before the fence is still in flight and can still be reinterpreted by
    // what arrives next, which is the entire reason the plain-text tail exists.
    const { openTail, openFence } = splitClosedPrefix(
      'settled\n\nstill writing this line\n```ts\nconst a = 1;'
    );
    expect(openTail).toBe('still writing this line');
    expect(openFence).toBe('```ts\nconst a = 1;');
  });

  it('does not parse prose that follows a fence which already closed', () => {
    // Only an UNTERMINATED fence qualifies. Once it closes, whatever follows is
    // ordinary in-flight Markdown again and goes back to the plain-text rule.
    const { openTail, openFence } = splitClosedPrefix('```ts\nx\n```\nand then some prose');
    expect(openFence).toBeUndefined();
    expect(openTail).toContain('and then some prose');
  });

  it('both commit happily on ordinary prose — the difference is only the fence', () => {
    // Stated so the verdict is not read as "pi-app's is bad". On text with no
    // fence it reaches the same kind of boundary, and sooner.
    const prose = 'First paragraph is done.\n\nSecond paragraph is still being written right now';
    expect(piAppSplit(prose).committed).toContain('First paragraph');
    expect(splitClosedPrefix(prose).segments.join('\n')).toContain('First paragraph');
  });
});
