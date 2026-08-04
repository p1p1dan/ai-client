import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_CODE_LANGUAGES,
  CHAT_HIGHLIGHT_MAX_CHARS,
  CHAT_HIGHLIGHT_MAX_LINE_CHARS,
  CHAT_HIGHLIGHT_MAX_LINES,
  type ChatCodeLanguage,
  type ChatCodeToken,
  chatCodeTokenStyle,
  normalizeCodeLanguage,
} from '../chatMarkdownPolicy';
import { CHAT_SHIKI_THEMES, clearChatHighlightCache, highlightChatCode } from '../chatShiki';
import { stripComments } from './stripComments';

/**
 * T-29 F-C8: the highlight chain, run for real — a grammar actually loaded, a
 * fence actually tokenised.
 *
 * Everything else in the T-29 suite stops short of it on both sides.
 * `chatMarkdownPolicy.test.ts` decides which language id a fence maps to and
 * then stops; `chatMarkdownRender.test.ts` asserts the FIRST-PAINT box, because
 * `renderToStaticMarkup` runs no effects and `ChatCodeBlock` resolves its
 * tokens in one. Between the two sat the part that actually colours code, with
 * no coverage at all — measured by breaking it three ways and watching the
 * whole suite stay green:
 *
 *  - `ensureLanguage` forced to `false`: all 27 languages silently degrade to
 *    an un-highlighted `<pre>`, i.e. the feature is gone;
 *  - `style={chatCodeTokenStyle(token)}` replaced with `style={{}}`: every
 *    token loses its colour and the block renders in body-text grey;
 *  - `ChatCodeBlock`'s inter-line `'\n'` deleted: the whole fence collapses
 *    onto ONE line the instant shiki resolves.
 *
 * None of that is an environment limit. shiki runs perfectly well here — the
 * 27-grammar sweep below is ~2s in this node worker — so the gap was only ever
 * a missing file.
 *
 * ## What this file can and cannot reach
 *
 * The highlighted rendering of `ChatCodeBlock` is unreachable without a DOM,
 * and this repo's vitest is node-only by config. So the contract is pinned from
 * both ends instead of from the middle: the TOKEN model is asserted to
 * reassemble into the exact source text (F-C8a), and the two lines of the
 * component that do the reassembling are asserted to exist by a source scan
 * (F-C8f). Neither half is sufficient alone; together they close the loop that
 * a single render test would have closed if one were possible.
 */

/**
 * One sample that is lexically plausible in all 27 grammars: an identifier run,
 * a call with a string argument, a blank line, an assignment.
 *
 * The blank line is the deliberate part. shiki emits an EMPTY token array for
 * it, so it is the case that makes the round trip below non-trivial — a
 * reassembly that dropped empty lines would still satisfy a same-characters
 * check on any other input.
 */
const SAMPLE = 'alpha beta\n  gamma("delta")\n\nepsilon = 1';
const SAMPLE_LINE_COUNT = 4;

/**
 * The exact text a highlighted `<pre>` must end up containing, reassembled the
 * way `ChatCodeBlock` reassembles it: token contents concatenated within a
 * line, lines joined by a single `\n` text node.
 */
function joinTokenLines(lines: ChatCodeToken[][]): string {
  return lines.map((line) => line.map((token) => token.content).join('')).join('\n');
}

// ---------------------------------------------------------------------------
// F-C8a: every supported grammar loads, and the token model round-trips
// ---------------------------------------------------------------------------

describe('F-C8: every supported grammar loads and tokenises', () => {
  it('F-C8: all 27 canonical ids return tokens that rebuild the source exactly', async () => {
    expect(CHAT_CODE_LANGUAGES).toHaveLength(27);
    for (const language of CHAT_CODE_LANGUAGES) {
      const lines = await highlightChatCode({ code: SAMPLE, language, isDark: true });
      // `null` is the "render it plain" fallback. It is the right answer for an
      // unknown language and a silent loss of the feature for a supported one,
      // which is why the closed list is walked one entry at a time rather than
      // spot-checked: a grammar whose chunk stops resolving fails HERE and
      // nowhere else in the app.
      expect(lines, language).not.toBeNull();
      expect(lines?.length, language).toBe(SAMPLE_LINE_COUNT);
      // The round trip. This is the contract `ChatCodeBlock` renders against —
      // highlighted and un-highlighted must be the same characters in the same
      // box, or the block reflows the moment shiki lands.
      expect(joinTokenLines(lines ?? []), language).toBe(SAMPLE);
    }
  });

  it('F-C8: no token ever spans a line break, which is what makes the join exact', async () => {
    for (const language of CHAT_CODE_LANGUAGES) {
      const lines = (await highlightChatCode({ code: SAMPLE, language, isDark: true })) ?? [];
      for (const line of lines) {
        for (const token of line) {
          // A token carrying its own `\n` would make the line array a lie: the
          // round trip above could still pass while the rendered block gained a
          // line the source did not have.
          expect(token.content, `${language}: ${JSON.stringify(token.content)}`).not.toContain(
            '\n'
          );
        }
      }
    }
  });

  it('F-C8: the round trip survives blank lines, tabs, trailing space and non-ASCII', async () => {
    const gnarly = [
      'const s = "h\u00e9llo \u2014 \u4e16\u754c"\t// tab before this',
      '',
      '   ',
      'const t = 2   ',
      '',
    ].join('\n');
    for (const language of ['typescript', 'python', 'yaml', 'markdown', 'diff'] as const) {
      const lines = await highlightChatCode({ code: gnarly, language, isDark: true });
      expect(lines, language).not.toBeNull();
      expect(joinTokenLines(lines ?? []), language).toBe(gnarly);
    }
  });

  /**
   * The one input where the round trip is NOT byte-exact, pinned so that it is
   * a known deviation rather than a surprise.
   *
   * A `\r\n` fence reaches `ChatCodeBlock` with its carriage returns intact
   * (measured through the real markdown pipeline — remark does not normalise
   * them), and shiki drops them. The rendering is unaffected because CSS treats
   * CR as a segment break, so `\r\n` and `\n` are one line break either way;
   * what changes is only that `ChatCodeBlock`'s "re-emits the identical
   * characters" is exact for LF input and equal-modulo-CR for CRLF input.
   */
  it('F-C8: CRLF is normalised to LF by the tokenizer, and nothing else changes', async () => {
    const crlf = 'const a = 1\r\nconst b = 2';
    const lines = await highlightChatCode({ code: crlf, language: 'ts', isDark: true });
    expect(lines).not.toBeNull();
    expect(joinTokenLines(lines ?? [])).toBe(crlf.replace(/\r\n/g, '\n'));
  });
});

// ---------------------------------------------------------------------------
// F-C8b: the alias table, all the way to a grammar
// ---------------------------------------------------------------------------

/**
 * The alias table, restated.
 *
 * `CHAT_CODE_LANGUAGE_ALIASES` is module-private in `chatMarkdownPolicy.ts`, so
 * it cannot be imported. Restating it would normally just move the risk — an
 * alias added to the source and not to this copy would go untested — so the
 * first test below re-reads the real table out of the source and fails if the
 * two diverge. That is the guard that matters: `normalizeCodeLanguage` is
 * already unit-tested, but "resolves to an id" and "that id has a grammar
 * behind it" are different claims, and only the second one colours anything.
 */
const CHAT_CODE_LANGUAGE_ALIASES: Readonly<Record<string, ChatCodeLanguage>> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  patch: 'diff',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellscript: 'shell',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml',
};

describe('F-C8: an aliased fence reaches a real grammar', () => {
  it('F-C8: this file covers every alias the policy actually ships', () => {
    const file = 'chatMarkdownPolicy.ts';
    const source = stripComments(
      readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'),
      file
    );
    const block = /CHAT_CODE_LANGUAGE_ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
    // Without this the scan below would silently compare against nothing, and a
    // renamed table would read as "no aliases have been added".
    expect(block, 'the alias object literal was not found in the source').toBeDefined();
    const shipped: Record<string, string> = {};
    for (const entry of (block ?? '').matchAll(/(?:'([^']+)'|([\w$+#]+))\s*:\s*'([a-z]+)'/g)) {
      shipped[entry[1] ?? entry[2]] = entry[3];
    }
    expect(shipped).toEqual(CHAT_CODE_LANGUAGE_ALIASES);
  });

  it('F-C8: every alias both resolves AND highlights', async () => {
    // A sample distinct from `SAMPLE`, so each alias genuinely tokenises rather
    // than echoing a cache entry the canonical sweep already wrote.
    const code = 'zeta("eta")\ntheta = 2';
    for (const [raw, canonical] of Object.entries(CHAT_CODE_LANGUAGE_ALIASES)) {
      expect(normalizeCodeLanguage(raw), raw).toBe(canonical);
      const lines = await highlightChatCode({ code, language: raw, isDark: true });
      expect(lines, raw).not.toBeNull();
      expect(joinTokenLines(lines ?? []), raw).toBe(code);
    }
  });

  it('F-C8: an info string carrying attributes still finds its grammar', async () => {
    // The forms models actually emit: twoslash, line ranges, and the Docusaurus
    // `lang:path` shape. Asserted through the whole chain rather than against
    // `normalizeCodeLanguage` alone, because a mis-parsed info string is only
    // visible as "this fence lost its colour".
    for (const language of ['ts twoslash', 'js {1,3-4}', 'ts:src/index.ts', '  Python  ', 'TSX']) {
      const lines = await highlightChatCode({ code: 'omega = 3', language, isDark: true });
      expect(lines, language).not.toBeNull();
      expect(joinTokenLines(lines ?? []), language).toBe('omega = 3');
    }
  });
});

// ---------------------------------------------------------------------------
// F-C8c: the plain-text fallback, and what it costs
// ---------------------------------------------------------------------------

describe('F-C8: the plain-text fallback', () => {
  it('F-C8: an unsupported or absent language is null', async () => {
    for (const language of ['brainfuck', 'text', 'plaintext', 'mermaid', '', '   ', null]) {
      expect(
        await highlightChatCode({ code: 'x = 1', language, isDark: true }),
        String(language)
      ).toBeNull();
    }
  });

  it('F-C8: a prototype-chain key is null, not a non-string language', async () => {
    // Necessary but NOT sufficient, and the insufficiency is the point: with the
    // `Object.hasOwn` guard removed from `normalizeCodeLanguage`, a bare lookup
    // answers `__proto__` with `Object.prototype`, which is non-null, survives
    // the `if (!language)` fast path, and only fails later at
    // `LANGUAGE_LOADERS[…]` — so the result is still `null` and this assertion
    // still passes. What the guard actually buys is asserted below, in the
    // construction probe: not building a highlighter for a fence that can never
    // be highlighted.
    for (const language of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(
        await highlightChatCode({ code: 'x = 1', language, isDark: true }),
        language
      ).toBeNull();
    }
  });

  it('F-C8: each of the three budget axes sends the fence down the plain path', async () => {
    // Too many lines — well inside the byte and width budgets.
    const tooManyLines = 'x\n'.repeat(CHAT_HIGHLIGHT_MAX_LINES);
    expect(tooManyLines.length).toBeLessThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(
      await highlightChatCode({ code: tooManyLines, language: 'ts', isDark: true })
    ).toBeNull();

    // Too wide on ONE line — the axis a byte budget alone does not cover, and
    // the expensive one: tokenising a single line is roughly quadratic.
    //
    // BOTH positions are checked, because the width budget is enforced by two
    // separate expressions: one inside the newline loop, for a long line with
    // something after it, and one after the loop, for the final line. Measured:
    // deleting the in-loop check alone leaves the trailing check covering the
    // single-line case, so a test that only passed `'a'.repeat(n)` stayed green
    // on a build where any long line followed by a short one was highlighted.
    const tooWideLastLine = 'a'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS + 1);
    expect(tooWideLastLine.length).toBeLessThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(
      await highlightChatCode({ code: tooWideLastLine, language: 'ts', isDark: true })
    ).toBeNull();

    const tooWideInnerLine = `${'a'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS + 1)}\nshort`;
    expect(
      await highlightChatCode({ code: tooWideInnerLine, language: 'ts', isDark: true })
    ).toBeNull();

    // Too big overall, with every line inside the width budget and far fewer
    // than 800 of them, so only the byte axis can be what rejects it.
    const wideLine = `${'a'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS)}\n`;
    const tooBig = wideLine.repeat(Math.ceil(CHAT_HIGHLIGHT_MAX_CHARS / wideLine.length) + 1);
    expect(tooBig.length).toBeGreaterThan(CHAT_HIGHLIGHT_MAX_CHARS);
    expect(tooBig.split('\n').length).toBeLessThan(CHAT_HIGHLIGHT_MAX_LINES);
    expect(await highlightChatCode({ code: tooBig, language: 'ts', isDark: true })).toBeNull();
  });

  it('F-C8: a fence exactly at the line budget is still highlighted', async () => {
    // The boundary in the other direction, so "reject everything" cannot pass
    // the test above.
    const atLimit = 'x\n'.repeat(CHAT_HIGHLIGHT_MAX_LINES - 1);
    const lines = await highlightChatCode({ code: atLimit, language: 'ts', isDark: true });
    expect(lines).not.toBeNull();
    expect(lines?.length).toBe(CHAT_HIGHLIGHT_MAX_LINES);
    expect(joinTokenLines(lines ?? [])).toBe(atLimit);
  });

  /**
   * The claim in `highlightChatCode`'s own comment — "checked before the
   * highlighter is even constructed, so an oversized fence in a session with no
   * other code costs nothing at all" — asserted rather than timed.
   *
   * A stopwatch would only say "fast", and fast is also what a warm singleton
   * looks like. Mocking `createHighlighterCore` in a fresh module registry says
   * the thing the comment actually claims: it was never called.
   */
  it('F-C8: a rejected fence never constructs the highlighter', async () => {
    const constructed: string[] = [];
    vi.resetModules();
    vi.doMock('shiki/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('shiki/core')>();
      return {
        ...actual,
        createHighlighterCore: (...args: unknown[]) => {
          constructed.push('createHighlighterCore');
          return (actual.createHighlighterCore as (...a: never[]) => unknown)(...(args as never[]));
        },
      };
    });
    try {
      const fresh = await import('../chatShiki');
      expect(
        await fresh.highlightChatCode({
          code: 'a'.repeat(CHAT_HIGHLIGHT_MAX_LINE_CHARS + 1),
          language: 'ts',
          isDark: true,
        })
      ).toBeNull();
      expect(constructed, 'an over-budget fence built the highlighter anyway').toEqual([]);

      expect(
        await fresh.highlightChatCode({ code: 'x = 1', language: 'brainfuck', isDark: true })
      ).toBeNull();
      expect(constructed, 'an unknown language built the highlighter anyway').toEqual([]);

      // The `Object.hasOwn` guard, asserted by its actual consequence. A bare
      // `CHAT_CODE_LANGUAGE_ALIASES[first]` answers `__proto__` with
      // `Object.prototype` — truthy, so the fast path lets it through and the
      // whole shiki singleton gets built for a fence that can never be
      // highlighted. The returned value is `null` either way, which is why this
      // is the assertion that has to carry the guard.
      expect(
        await fresh.highlightChatCode({ code: 'x = 1', language: '__proto__', isDark: true })
      ).toBeNull();
      expect(constructed, 'a prototype-chain key built the highlighter anyway').toEqual([]);

      // The positive control. Without it, "never constructed" would also pass on
      // a module that had lost the ability to construct one at all.
      expect(
        await fresh.highlightChatCode({ code: 'const a = 1', language: 'ts', isDark: true })
      ).not.toBeNull();
      expect(constructed).toEqual(['createHighlighterCore']);
    } finally {
      vi.doUnmock('shiki/core');
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// F-C8d: the token cache
// ---------------------------------------------------------------------------

describe('F-C8: the token cache', () => {
  const CODE = 'const cached = 1';

  it('F-C8: the same fence in the same theme is served from the cache', async () => {
    clearChatHighlightCache();
    const first = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    const second = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    expect(first).not.toBeNull();
    // Identity, not deep equality: a re-tokenised result is deeply equal but a
    // fresh array, so `toBe` is the only thing that tells a hit from a miss.
    expect(second).toBe(first);
  });

  it('F-C8: the theme is part of the key, so a light/dark flip is not served stale', async () => {
    clearChatHighlightCache();
    const dark = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    const light = await highlightChatCode({ code: CODE, language: 'ts', isDark: false });
    expect(light).not.toBe(dark);
    // …and it is a genuinely different rendering, not merely a different array:
    // vitesse-light and vitesse-dark disagree on the first keyword's colour.
    expect(light?.[0]?.[0]?.color).not.toBe(dark?.[0]?.[0]?.color);
    // Both survive side by side, so the flip back is a hit too.
    expect(await highlightChatCode({ code: CODE, language: 'ts', isDark: true })).toBe(dark);
    expect(await highlightChatCode({ code: CODE, language: 'ts', isDark: false })).toBe(light);
  });

  it('F-C8: the language is part of the key', async () => {
    clearChatHighlightCache();
    const asTs = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    const asPython = await highlightChatCode({ code: CODE, language: 'py', isDark: true });
    expect(asTs).not.toBeNull();
    expect(asPython).not.toBe(asTs);
  });

  it('F-C8: clearChatHighlightCache really empties it', async () => {
    clearChatHighlightCache();
    const before = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    clearChatHighlightCache();
    const after = await highlightChatCode({ code: CODE, language: 'ts', isDark: true });
    // A fresh array (so the entry was gone) carrying identical tokens (so the
    // cache was only ever a cache).
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it('F-C8: the cache is bounded at 64 and evicts the LEAST RECENTLY USED entry', async () => {
    clearChatHighlightCache();
    const fence = (i: number) => `const n${i} = ${i}`;
    const highlight = (i: number) =>
      highlightChatCode({ code: fence(i), language: 'ts', isDark: true });

    const entry0 = await highlight(0);
    const entry1 = await highlight(1);
    for (let i = 2; i < 64; i += 1) await highlight(i);
    // 64 entries; entry 0 is the oldest by insertion. Reading it must make it
    // the NEWEST — that is the whole point of the re-insert in `readCache`.
    expect(await highlight(0)).toBe(entry0);

    // The 65th entry has to evict something.
    await highlight(64);
    // Not entry 0: it was just used. A plain `Map.get` with no re-insert would
    // have left it oldest, and this is the assertion that fails in that case.
    expect(await highlight(0), 'the most recently used entry was evicted').toBe(entry0);
    // Entry 1 is the oldest now, and it is the one that went — which is also
    // the proof that the bound is enforced at all.
    expect(await highlight(1), 'the cache grew past its bound').not.toBe(entry1);
  });
});

// ---------------------------------------------------------------------------
// F-C8e: the shape `chatCodeTokenStyle` is fed
// ---------------------------------------------------------------------------

describe('F-C8: the tokens satisfy what chatCodeTokenStyle expects', () => {
  it('F-C8: every token in every grammar and both themes carries a usable colour', async () => {
    for (const language of CHAT_CODE_LANGUAGES) {
      for (const isDark of [true, false]) {
        const lines = (await highlightChatCode({ code: SAMPLE, language, isDark })) ?? [];
        expect(lines.length, language).toBe(SAMPLE_LINE_COUNT);
        for (const line of lines) {
          for (const token of line) {
            const where = `${language} ${isDark ? 'dark' : 'light'} ${JSON.stringify(token.content)}`;
            expect(token.content, where).not.toBe('');
            // `chatCodeTokenStyle` only emits `color` when the token has one, so
            // a theme that stopped reporting colours would degrade silently to
            // body-text grey rather than fail.
            expect(token.color, where).toMatch(/^#[0-9A-Fa-f]{6,8}$/);
            if (token.fontStyle !== undefined) {
              expect(typeof token.fontStyle, where).toBe('number');
            }
          }
        }
      }
    }
  });

  it('F-C8: real italic and bold bits arrive as real CSS, and nothing else does', async () => {
    // A markdown fence is the sample that exercises both TextMate bits in the
    // bundled themes: `*em*` is italic (1), `**strong**` is bold (2).
    const lines =
      (await highlightChatCode({
        code: '*em* and **strong**',
        language: 'markdown',
        isDark: true,
      })) ?? [];
    const styles = lines.flat().map((token) => chatCodeTokenStyle(token));
    expect(styles.length).toBeGreaterThan(0);
    expect(
      styles.some((style) => style.fontStyle === 'italic'),
      'no italic token came out of a markdown fence'
    ).toBe(true);
    expect(
      styles.some((style) => style.fontWeight === 'bold'),
      'no bold token came out of a markdown fence'
    ).toBe(true);
    expect(styles.every((style) => typeof style.color === 'string')).toBe(true);
    // The style object is the only value on this path that is not React-escaped
    // text, so what it may contain is closed: three keys, no others.
    for (const style of styles) {
      for (const key of Object.keys(style)) {
        expect(['color', 'fontStyle', 'fontWeight']).toContain(key);
      }
    }
  });

  it('F-C8: the themes are the vitesse pair the file preview also uses', () => {
    expect(CHAT_SHIKI_THEMES.dark).toBe('vitesse-dark');
    expect(CHAT_SHIKI_THEMES.light).toBe('vitesse-light');
  });
});

// ---------------------------------------------------------------------------
// F-C8f: the consumer, scanned — the half a node suite cannot render
// ---------------------------------------------------------------------------

/**
 * `ChatCodeBlock`'s highlighted output has no test that can render it: the
 * tokens arrive in a `useEffect`, `renderToStaticMarkup` runs no effects, and
 * the suite has no DOM environment. So the two expressions that consume the
 * token model are asserted to be present in the source instead.
 *
 * This is the weaker kind of assertion and it is used deliberately narrowly —
 * only for the two lines whose deletion is invisible everywhere else. The
 * security prohibitions on the same file (no `dangerouslySetInnerHTML`, no
 * `src`-bearing element) already have their scan in `chatMarkdownPolicy.test.ts`
 * and are not repeated here.
 */
describe('F-C8: ChatCodeBlock still consumes the token model it is handed', () => {
  const FILE = 'ChatCodeBlock.tsx';
  const source = stripComments(
    readFileSync(fileURLToPath(new URL(`../${FILE}`, import.meta.url)), 'utf8'),
    FILE
  );

  it('F-C8: the scanned source is real code with its comments blanked', () => {
    // The vacuity guard. `stripComments` blanks rather than deletes, so length
    // proves nothing — the non-blank content is what has to be non-trivial.
    expect(source.replace(/\s+/g, '').length).toBeGreaterThan(400);
    // Prose that exists ONLY in this file's doc comments. If it survives the
    // strip, every positive below could be matching a comment rather than code.
    expect(source).not.toContain('Trust boundary');
    expect(source).not.toContain('No layout shift');
  });

  it('F-C8: each token is painted through chatCodeTokenStyle', () => {
    // `style={{}}` in place of this renders every fence in body-text grey, and
    // no other test in the repo can see the difference.
    expect(source).toMatch(/style=\{\s*chatCodeTokenStyle\(\s*token\s*\)\s*\}/);
    // …and the content crosses as a React text child, which is what makes the
    // escaping structural rather than reviewed.
    expect(source).toMatch(/\{\s*token\.content\s*\}/);
  });

  it('F-C8: the lines are rejoined with a real newline, which is the no-reflow contract', () => {
    // The token model round-trips to the source text only if the caller puts
    // the line breaks back (F-C8a). Delete this and the highlighted form
    // collapses the whole fence onto one line the instant shiki resolves —
    // the largest layout shift the component could produce, and precisely the
    // one its design note promises cannot happen.
    expect(source).toMatch(/lines\.length\s*-\s*1\s*\?\s*'\\n'/);
    // The un-highlighted branch is the raw code, unmodified: same characters,
    // same box, before and after.
    expect(source).toMatch(/:\s*code\}/);
  });
});
