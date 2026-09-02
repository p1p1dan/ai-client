import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * D25 §6.3 A1/A5/A6: repo-wide static scans for the font-domain split.
 * Node `fs` only (no shell-out) so this runs identically in CI and locally.
 *
 * Mirrors the `stripComments`/`collectFiles` convention already established
 * in `composerFormStatic.test.ts` -- these scans read CODE, not the doc
 * comments that (necessarily, for a project like this) quote the very class
 * names they ban or restrict.
 *
 * `stripComments` is the shared, parser-backed one (see its own note). The
 * private regex pair that used to sit here was over-stripping 12 files under
 * `src/renderer` -- among them `chat/EnhancedInput.tsx`, whose `accept="image/*"`
 * paired with a later block-comment terminator and deleted the JSX between them,
 * and `workspace-shell/deriveChatWorkspaceTree.ts`, whose
 * `replace(/^refs\/heads\//, '')` ended in the characters `\`, `/`, `/` and took
 * the rest of its line with it. Both files are inside the scans below, so the
 * scans were reading code that is not what the file says.
 */

const RENDERER_ROOT = join(process.cwd(), 'src/renderer');
const CHAT_DIR = join(RENDERER_ROOT, 'components/chat');
const WORKSPACE_SHELL_DIR = join(RENDERER_ROOT, 'components/workspace-shell');

/** One file's code, comments blanked. The name is what tells `.ts` from `.tsx`. */
function readStripped(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function relToRenderer(file: string): string {
  return file.slice(RENDERER_ROOT.length + 1).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// A1: font-mono is a closed whitelist.
// ---------------------------------------------------------------------------

/**
 * D25 §2.5: mono is opt-in (sans is the default), so every file on this list
 * earned its place -- code blocks, terminal-adjacent chrome, diff/patch
 * viewers, path/hash/branch display, and the two `ui/ident.tsx` primitives.
 * Regenerate by scanning `src/renderer` (comments stripped) for `font-mono`
 * and diffing the file set against this array; don't grow it silently.
 *
 * IMPORTANT -- this whitelist is NOT the full set of mono text in the app, and
 * a short list is not evidence that mono is under-used. Tailwind v4's preflight
 * ships a bare-element rule (`preflight.css`: `code, kbd, samp, pre { font-family:
 * --theme(--default-mono-font-family, ...) }`) and `theme.css` resolves
 * `--default-mono-font-family` to `--font-mono` -- our own stack. So every
 * `<code>`/`<kbd>`/`<samp>`/`<pre>` in this repo is already mono WITHOUT
 * carrying a `font-mono` class, and that is load-bearing: `ui/code-block.tsx`'s
 * shiki path injects highlighted `<pre><code>` markup through
 * `dangerouslySetInnerHTML`, so no class of ours can reach those elements and
 * the preflight rule is the only thing making highlighted code monospace.
 *
 * Two failure modes follow, and both have to be argued against explicitly
 * before anyone "tidies" this file:
 *  - Do NOT read a file's absence here as "this surface lost its mono" and
 *    add `font-mono` to a code block to "fix" it -- it was never broken, and
 *    the class would be redundant everywhere except where it silently fights
 *    a future domain change.
 *  - Do NOT trim this whitelist toward the preflight set. These entries are
 *    the mono usages preflight canNOT cover (spans, divs, buttons carrying
 *    paths / hashes / branch names), which is exactly why they need a
 *    deliberate opt-in and an auditable list.
 */
const FONT_MONO_WHITELIST: readonly string[] = [
  'components/ErrorBoundary.tsx',
  'components/chat/ChatComposer.tsx',
  'components/chat/EnhancedInput.tsx',
  'components/chat/HitListPopover.tsx',
  'components/chat/HostStatusBanner.tsx',
  'components/chat/MessageTimeline.tsx',
  'components/chat/StatusLine.tsx',
  'components/chat/TargetBranchSelect.tsx',
  'components/chat/ToolRows.tsx',
  'components/chat/toolCard.ts',
  'components/files/EditorLineComment.tsx',
  'components/files/MarkdownPreview.tsx',
  'components/files/editorDefinitionProvider.ts',
  'components/git/AddRepositoryDialog.tsx',
  'components/git/FileChanges.tsx',
  'components/onboarding/OnboardingView.tsx',
  'components/repository/RepositorySettingsDialog.tsx',
  'components/sessions/SessionItem.tsx',
  'components/sessions/SessionManagerView.tsx',
  'components/settings/GeneralSettings.tsx',
  'components/source-control/ChangesList.tsx',
  'components/source-control/ChangesTree.tsx',
  'components/source-control/CodeReviewModal.tsx',
  'components/source-control/CommitHistoryList.tsx',
  'components/source-control/DiffReviewModal.tsx',
  'components/source-control/ResetModeDialog.tsx',
  'components/source-control/SourceControlPanel.tsx',
  // D34 commit-expand file list: monospace status letters, same rationale as ChangesList.
  'components/workspace-shell/surfaces/GitHistoryList.tsx',
  'components/ui/code-block.tsx',
  'components/ui/ident.tsx',
  'components/ui/mermaid-renderer.tsx',
];

// ---------------------------------------------------------------------------
// A5: font-mono elements never carry a non-zero tracking-* class.
// ---------------------------------------------------------------------------

/**
 * `tracking-normal` is a no-op alongside `font-mono` (it's the ident/code
 * primitives' own explicit reset, D25 §3.3) so it is exempt. The ONLY other
 * exemption is `OnboardingView.tsx`'s OTP input, which intentionally pairs
 * `font-mono` with `tracking-[0.5em]` for visual digit separation (D25 §3.3
 * M9) -- a file-level exemption, not a class-level one.
 */
const TRACKING_MONO_FILE_EXEMPTIONS: readonly string[] = [
  'components/onboarding/OnboardingView.tsx',
];

/**
 * The literal-level scan below can only see `font-mono` and `tracking-*`
 * written into the SAME class string. `letter-spacing` is an inherited CSS
 * property, so an ancestor's `tracking-[…]` reaches a `font-mono` descendant
 * that never spells a tracking class at all -- a violation of D25 §3.3 that
 * the literal scan is structurally blind to.
 *
 * A static scan cannot resolve JSX ancestry, so this list backs a deliberately
 * COARSER second gate: any file where the two appear at all must be
 * adjudicated by a human once and recorded here with the reason. That trades
 * a few one-time judgements for closing the inheritance hole entirely.
 * A new entry needs an argument, not just a passing suite.
 */
const TRACKING_MONO_COEXISTENCE_EXEMPTIONS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'components/onboarding/OnboardingView.tsx',
    reason:
      'OTP input pairs font-mono with tracking-[0.5em] on ONE element on purpose (D25 §3.3 M9) — already the literal-level exemption above.',
  },
  {
    file: 'components/sessions/SessionManagerView.tsx',
    reason:
      'Adjudicated: legal coexistence, no inheritance path. tracking-[-0.01em] sits on the two 18px `font-heading text-title` headings (:53, :115) — the only tier D25 permits negative tracking on ("<18px 一律非负"). Each font-mono element (:57 project path, :218 project-card path) is a SIBLING subtree of those headings, never a descendant, so no letter-spacing is inherited into mono text.',
  },
];

/** Matches quoted/templated string literals so `font-mono`/`tracking-*` are only compared within the same class string, not merely the same file. */
const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/**
 * File-level presence probes for the coarse gate. Word-boundary guards keep
 * `tracking-normal` (the ident/code primitives' own explicit reset, a no-op
 * next to `font-mono`) out of the match, and the leading lookbehind stops
 * `tracking-` from matching inside a longer custom token.
 */
const FILE_FONT_MONO_RE = /\bfont-mono\b/;
const FILE_NONZERO_TRACKING_RE = /(?<![\w-])tracking-(?!normal\b)[\w[\]./-]+/;

function findMonoTrackingViolations(source: string): string[] {
  const violations: string[] = [];
  let match: RegExpExecArray | null;
  STRING_LITERAL_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = STRING_LITERAL_RE.exec(source)) !== null) {
    const literal = match[2];
    if (!/\bfont-mono\b/.test(literal)) continue;
    const trackingTokens = literal.match(/\btracking-\S+/g) ?? [];
    const offending = trackingTokens.filter((token) => token !== 'tracking-normal');
    if (offending.length > 0) violations.push(literal);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// A6: banned raw size utilities are zero in chat/ + workspace-shell/.
// ---------------------------------------------------------------------------

/**
 * Token-level, not substring-level. The earlier form tested the raw source for
 * `(^|\s)text-xs(\s|'|"|$)`, which is delimited by WHITESPACE -- so any variant
 * prefix hid the ban completely: `md:text-xs`, `hover:text-xs` and
 * `data-[state=open]:text-xs` all rendered the banned size and all passed,
 * because the character before `text-xs` was `:` rather than a space. Variants
 * are how a size actually reaches the screen at a breakpoint or in a state, so
 * a scan that stops at the prefix is checking the least interesting case.
 *
 * So: pull class strings out of the source, split on whitespace, drop every
 * variant prefix (everything up to and including the LAST `:` -- `lastIndexOf`
 * rather than `split(':')[1]`, so an arbitrary value that itself contains a
 * colon, e.g. `supports-[corner-shape:squircle]:text-xs`, still reduces to its
 * real base) and compare the BASE NAME for exact equality. Exact equality also
 * removes the `text-background` / `text-base` hazard by construction: they are
 * different tokens, so no word-boundary guard is needed to keep them apart.
 */
const BANNED_SIZE_TOKENS = ['text-xs', 'text-base', 'text-[10px]', 'text-[11px]'] as const;

function baseUtility(token: string): string {
  return token.slice(token.lastIndexOf(':') + 1);
}

/** Every occurrence of `banned` (variant prefixes stripped) inside `source`'s class strings. */
function findBannedSizeTokens(source: string, banned: string): string[] {
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  STRING_LITERAL_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = STRING_LITERAL_RE.exec(source)) !== null) {
    for (const token of match[2].split(/\s+/)) {
      if (token && baseUtility(token) === banned) hits.push(token);
    }
  }
  return hits;
}

describe('D25 §6.3 A1: font-mono is a closed whitelist', () => {
  it('every font-mono occurrence under src/renderer lives in a whitelisted file', () => {
    const files = collectFiles(RENDERER_ROOT);
    const offenders = files
      .map((file) => relToRenderer(file))
      .filter((rel) => {
        const full = join(RENDERER_ROOT, rel);
        return /\bfont-mono\b/.test(readStripped(full));
      })
      .filter((rel) => !FONT_MONO_WHITELIST.includes(rel));

    expect(offenders).toEqual([]);
  });
});

describe('D25 §6.3 A5: font-mono elements never carry a non-zero tracking-*', () => {
  it('no whitelisted file pairs font-mono with a non-normal tracking- class (OTP file exempt)', () => {
    const offenders: Array<{ file: string; literal: string }> = [];
    for (const rel of FONT_MONO_WHITELIST) {
      if (TRACKING_MONO_FILE_EXEMPTIONS.includes(rel)) continue;
      const full = join(RENDERER_ROOT, rel);
      for (const literal of findMonoTrackingViolations(readStripped(full))) {
        offenders.push({ file: rel, literal });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the OTP input is the only same-string exemption, and it still pairs font-mono with tracking-[0.5em] on purpose', () => {
    for (const rel of TRACKING_MONO_FILE_EXEMPTIONS) {
      const full = join(RENDERER_ROOT, rel);
      const violations = findMonoTrackingViolations(readStripped(full));
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((literal) => literal.includes('tracking-[0.5em]'))).toBe(true);
    }
  });

  // The coarse second gate. `letter-spacing` INHERITS, so the same-string scan
  // above passes a file where an ancestor `<div className="… tracking-[-0.01em]">`
  // wraps a `<span className="font-mono">` that spells no tracking of its own —
  // the mono text is still tracked, and D25 §3.3 still says column alignment is
  // broken. A static scan cannot resolve JSX ancestry, so coexistence anywhere
  // in a file is treated as needing a recorded human judgement.
  it('no file mixes font-mono and a non-zero tracking- at all, outside the adjudicated list', () => {
    const exempt = new Set(TRACKING_MONO_COEXISTENCE_EXEMPTIONS.map((entry) => entry.file));
    const offenders = collectFiles(RENDERER_ROOT)
      .map((file) => relToRenderer(file))
      .filter((rel) => {
        const stripped = readStripped(join(RENDERER_ROOT, rel));
        return FILE_NONZERO_TRACKING_RE.test(stripped) && FILE_FONT_MONO_RE.test(stripped);
      })
      .filter((rel) => !exempt.has(rel));

    expect(offenders).toEqual([]);
  });

  // An exemption that stops being true is worse than no exemption: it is a
  // silenced check nobody rechecks. Each entry must still exhibit the
  // coexistence it was granted for, and must still carry its reason.
  it('every adjudicated coexistence exemption is still real and still carries its reason', () => {
    for (const entry of TRACKING_MONO_COEXISTENCE_EXEMPTIONS) {
      const stripped = readStripped(join(RENDERER_ROOT, entry.file));
      expect(FILE_FONT_MONO_RE.test(stripped)).toBe(true);
      expect(FILE_NONZERO_TRACKING_RE.test(stripped)).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});

describe('D25 §6.3 A6: banned raw size utilities are zero in chat/ + workspace-shell/', () => {
  const scanDirs = [CHAT_DIR, WORKSPACE_SHELL_DIR];

  const sources = scanDirs
    .flatMap((dir) => collectFiles(dir))
    .filter((file) => !file.includes('__tests__'))
    .map((file) => ({ rel: relToRenderer(file), src: readStripped(file) }));

  for (const banned of BANNED_SIZE_TOKENS) {
    it(`${banned} is gone, under every variant prefix`, () => {
      const offenders = sources
        .map(({ rel, src }) => ({ rel, hits: findBannedSizeTokens(src, banned) }))
        .filter(({ hits }) => hits.length > 0);
      expect(offenders).toEqual([]);
    });
  }

  // The two properties the token form buys, asserted on the matcher itself
  // rather than only on today's (clean) tree — a scan that silently stops
  // matching would otherwise keep passing forever.
  it('the scan sees banned sizes through responsive, state and data-attribute variants', () => {
    for (const banned of BANNED_SIZE_TOKENS) {
      for (const variant of [
        'md:',
        'hover:',
        'data-[state=open]:',
        'supports-[corner-shape:squircle]:',
      ]) {
        expect(findBannedSizeTokens(`"flex ${variant}${banned} gap-2"`, banned)).toEqual([
          `${variant}${banned}`,
        ]);
      }
    }
  });

  it('the scan compares whole tokens, so text-background never counts as text-base', () => {
    expect(findBannedSizeTokens('"text-background bg-foreground"', 'text-base')).toEqual([]);
    expect(findBannedSizeTokens('"hover:text-background"', 'text-base')).toEqual([]);
    // …while the real token, prefixed or not, still registers.
    expect(findBannedSizeTokens('"text-base"', 'text-base')).toEqual(['text-base']);
  });
});
