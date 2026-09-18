import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Guard for a defect that has shipped twice. `DialogPopup` (`ui/dialog.tsx`)
 * carries no padding of its own — all 24px of left/right breathing room comes
 * from `DialogHeader` (`p-6`), `DialogFooter` (`px-6`) and `DialogPanel`
 * (`px-6`). A dialog that puts body content directly under `DialogPopup`
 * without going through one of those three renders that body flush against
 * the popup's rounded border while the title above it sits 24px in — which is
 * exactly what shipped in the 2026-09-10 launch announcement
 * (`AnnouncementDialog`, fixed with a manual `px-6`) and the 2026-09-18
 * Pi-setup migration prompt (`AgentMigrationPrompt`, fixed by adding
 * `DialogPanel`).
 *
 * Both fixes were pinned afterwards with a test scoped to that one file.
 * Neither pin would have caught the other file, or the next one — which is
 * how the same defect reached a second dialog before anyone wrote a rule
 * general enough to say so. This suite is the repo-wide version: every
 * `.tsx` file under `src/renderer` that renders `<DialogPopup` must be
 * registered in `DIALOG_PADDING_MANIFEST` below, classified into one of four
 * shapes, and each shape's own claim is checked against the source. A new
 * dialog that skips the manifest fails loudly here instead of shipping
 * quietly; a manifest entry that stops matching its file (someone deletes
 * the `DialogPanel` it claims to have) fails too.
 *
 * ## The four shapes
 *
 *  - `panel`   — body wrapped in `<DialogPanel>`. The majority pattern in
 *                this repo, and the one to reach for by default.
 *  - `manual`  — body gets its own `px-6`/`p-6` by hand, for a dialog whose
 *                content needs something `DialogPanel`'s own `ScrollArea`
 *                does not give it (a height cap short of full growth, a DOM
 *                ref for scroll-position tracking, …). Requires a comment
 *                that says so: mechanically, this means the file must
 *                mention "DialogPanel" in prose near the body — none of
 *                these files import the component itself, so any hit is
 *                necessarily a comment, not real usage.
 *  - `no-body` — header (+ footer) only; nothing sits outside `DialogHeader`
 *                for the alignment rule to even apply to. Also covers a
 *                dialog that extends the header itself (a list, a footnote
 *                paragraph) rather than opening a sibling body region, since
 *                content that stays inside `DialogHeader` inherits its
 *                `p-6` for free.
 *  - `custom`  — the popup is one fully custom surface (its own title bar,
 *                its own scroller, its own sub-app) with no `DialogHeader`
 *                at all, so there is no 24px baseline to fall short of in
 *                the first place.
 *
 * `no-body` and `custom` cannot be PROVEN by a text scan — "there is no
 * unaccounted content anywhere in this file" is not a regex-checkable claim,
 * the same limitation `fontDomainScan.test.ts` documents for its own coarse
 * gates. What IS checked is the one-directional drift that matters most: a
 * `no-body`/`custom` entry whose file has since grown a `DialogPanel` /
 * `DialogHeader` it did not have before — the shape of "someone added a body
 * and forgot the wrapper."
 */

const RENDERER_ROOT = join(process.cwd(), 'src/renderer');

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function relToRenderer(file: string): string {
  return file.slice(RENDERER_ROOT.length + 1).replace(/\\/g, '/');
}

/** Comments blanked (safe against a doc comment that names `<DialogPopup>`
 * or `DialogPanel` while explaining why it isn't used). */
function readStripped(relFile: string): string {
  const full = join(RENDERER_ROOT, relFile);
  return stripComments(readFileSync(full, 'utf8'), full);
}

/** Comments kept — this is what the `manual` category's "is there a comment"
 * check reads, since the whole point is finding prose the stripped copy just
 * blanked out. */
function readRaw(relFile: string): string {
  return readFileSync(join(RENDERER_ROOT, relFile), 'utf8');
}

function countLiteral(source: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * The slice of `source` covering one `<DialogPopup>` occurrence, for a file
 * that registers more than one manifest entry. `marker` is a substring
 * unique to that occurrence's own opening tag (its `className`, typically);
 * the slice runs from there up to the NEXT `<DialogPopup` (or end of file).
 * A file with a single occurrence passes no marker and gets the whole file.
 */
function segmentFor(source: string, marker?: string): string {
  if (!marker) return source;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const next = source.indexOf('<DialogPopup', start + marker.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

/** Matches quoted/templated string literals, so class tokens are only ever
 * read out of an actual class string — same discipline as
 * `fontDomainScan.test.ts`'s `STRING_LITERAL_RE`. */
const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
const ACCEPTED_PADDING_TOKENS = new Set(['px-6', 'p-6']);

/**
 * Whole-token match inside class-string literals, variant prefixes (`sm:`,
 * `hover:`, …) stripped before comparison — so `max-w-6xl` or a plain `gap-6`
 * can never register as the 24px padding this is actually checking for, the
 * same reasoning `findBannedSizeTokens` in `fontDomainScan.test.ts` uses.
 */
function hasPaddingToken(segment: string): boolean {
  const re = new RegExp(STRING_LITERAL_RE);
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = re.exec(segment)) !== null) {
    for (const token of match[2].split(/\s+/)) {
      const base = token.slice(token.lastIndexOf(':') + 1);
      if (ACCEPTED_PADDING_TOKENS.has(base)) return true;
    }
  }
  return false;
}

type Category = 'panel' | 'manual' | 'no-body' | 'custom';

interface DialogEntry {
  /** Path relative to `src/renderer`. */
  file: string;
  category: Category;
  /** Why this file is classified this way. Kept here (not just in the
   * source comment) so the manifest itself is a readable audit list. */
  reason: string;
  /** Disambiguates which `<DialogPopup>` this entry covers, for a file that
   * registers more than one entry (only `App.tsx` today). Omit for a file
   * with a single occurrence. */
  marker?: string;
  /** How many `<DialogPopup>` occurrences this ONE entry accounts for.
   * Defaults to 1; `AddRepositoryDialog.tsx`'s two dialogs share one
   * `panel` entry, so it declares 2 instead of getting a second entry. */
  occurrences?: number;
}

const DIALOG_PADDING_MANIFEST: readonly DialogEntry[] = [
  {
    file: 'App.tsx',
    category: 'no-body',
    marker: 'className="sm:max-w-sm" showCloseButton={false}',
    reason:
      'The close-confirmation dialog: DialogTitle + DialogDescription in the header, Cancel/confirm buttons in the footer, nothing else — no body region for the 24px rule to apply to.',
  },
  {
    file: 'App.tsx',
    category: 'custom',
    marker: 'className="h-[90vh] max-w-[95vw] p-0"',
    reason:
      'The merge-conflict editor: DialogPopup wraps MergeEditor directly with p-0 and no DialogHeader at all, so there is no 24px title baseline for the content to fall short of — the editor IS the whole popup.',
  },
  {
    file: 'components/announcements/AnnouncementDialog.tsx',
    category: 'manual',
    reason:
      'Caps the announcement list at max-h-[50vh], narrower than DialogPanel’s own full-growth ScrollArea would allow — the bug’s first occurrence (2026-09-10), documented inline where the manual px-6 lives.',
  },
  {
    file: 'components/chat/SessionTreeDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (the session tree list) between header and footer.',
  },
  {
    file: 'components/files/NewItemDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (a single name input) between header and footer.',
  },
  {
    file: 'components/git/AddRepositoryDialog.tsx',
    category: 'panel',
    occurrences: 2,
    reason:
      'Two DialogPopups in this file — the main add-repository form and the nested SSH directory picker — both with a DialogPanel body.',
  },
  {
    file: 'components/remote/RemoteAuthPromptHost.tsx',
    category: 'panel',
    reason:
      'Standard DialogPanel body (SSH prompt details and the secret input) between header and footer.',
  },
  {
    file: 'components/repository/RepositorySettingsDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (the repository settings form) between header and footer.',
  },
  {
    file: 'components/settings/AgentMigrationPrompt.tsx',
    category: 'panel',
    reason:
      '2026-09-18 fix for this exact bug: originally shipped with the migration item list as a bare DialogPopup child, now wrapped in DialogPanel.',
  },
  {
    file: 'components/settings/GitSettings.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (the remote form) between header and footer.',
  },
  {
    file: 'components/settings/ProviderSetupDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (the AI service form) between header and footer.',
  },
  {
    file: 'components/settings/SettingsDialog.tsx',
    category: 'custom',
    reason:
      'The Settings shell: a p-0 DialogPopup with its own title bar (px-4 py-3, not DialogHeader) and its own two-pane SettingsContent layout — a different chrome contract entirely, not a body missing 24px.',
  },
  {
    file: 'components/source-control/CodeReviewModal.tsx',
    category: 'manual',
    reason:
      'Streamed review output needs a stable scroll ref (autoscroll-to-bottom plus "user scrolled up" detection) and flex-1 min-h-0 to fill whichever height the maximize toggle picked — documented inline where the manual px-6 lives.',
  },
  {
    file: 'components/temp-workspace/TempWorkspaceDialogs.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (a single rename input) between header and footer.',
  },
  {
    file: 'components/UpdateNotification.tsx',
    category: 'panel',
    reason:
      '2026-09-18 field fix for this exact bug: download progress / error / release notes were bare siblings of DialogHeader, now render inside a conditionally-mounted DialogPanel.',
  },
  {
    file: 'components/user/UserProfileCard.tsx',
    category: 'no-body',
    reason:
      'The logout-confirm dialog folds its loss list and CLI-note paragraph INTO DialogHeader (both still precede the closing </DialogHeader>), so they inherit the header’s own p-6 instead of needing a separate padded region.',
  },
  {
    file: 'components/workspace-shell/LeftDock.tsx',
    category: 'manual',
    reason:
      'The capabilities list caps itself at max-h-80 with its own overflow-y-auto, which DialogPanel’s ScrollArea would nest awkwardly under — same reasoning as AnnouncementDialog; documented inline where the manual px-6 lives.',
  },
  {
    file: 'components/worktree/CreateWorktreeDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (the worktree creation form) between header and footer.',
  },
  {
    file: 'components/worktree/MergeWorktreeDialog.tsx',
    category: 'panel',
    reason: 'Standard DialogPanel body (branch and merge options) between header and footer.',
  },
] as const;

describe('DialogPopup padding convention (repo-wide)', () => {
  it('every <DialogPopup> usage under src/renderer is registered, and no entry is stale', () => {
    const files = collectTsxFiles(RENDERER_ROOT).map(relToRenderer);
    const usageCounts = new Map<string, number>();
    for (const file of files) {
      const count = countLiteral(readStripped(file), '<DialogPopup');
      if (count > 0) usageCounts.set(file, count);
    }

    const manifestCounts = new Map<string, number>();
    for (const entry of DIALOG_PADDING_MANIFEST) {
      manifestCounts.set(
        entry.file,
        (manifestCounts.get(entry.file) ?? 0) + (entry.occurrences ?? 1)
      );
    }

    const offenders: string[] = [];

    for (const [file, count] of usageCounts) {
      const claimed = manifestCounts.get(file);
      if (claimed === undefined) {
        offenders.push(
          `${file}: renders <DialogPopup> ${count} time(s) but has no entry in DIALOG_PADDING_MANIFEST ` +
            `(src/renderer/components/ui/__tests__/dialogPopupPaddingStatic.test.ts). DialogPopup has no ` +
            `padding of its own. If this dialog has body content outside DialogHeader/DialogFooter, wrap it ` +
            `in <DialogPanel> (the default) and add a 'panel' entry; only use manual px-6 — with a comment ` +
            `explaining why not DialogPanel — for a real scroll/ref special case, and add a 'manual' entry; ` +
            `if there truly is no separate body, add a 'no-body' entry; if the popup is fully custom chrome ` +
            `with no DialogHeader, add a 'custom' entry.`
        );
      } else if (claimed !== count) {
        offenders.push(
          `${file}: source has ${count} <DialogPopup> occurrence(s) but the manifest entries for it claim ` +
            `${claimed}. Update 'occurrences' on the existing entry (or add/remove an entry) to match.`
        );
      }
    }

    for (const [file, claimed] of manifestCounts) {
      if (!usageCounts.has(file)) {
        offenders.push(
          `${file}: has a DIALOG_PADDING_MANIFEST entry claiming ${claimed} <DialogPopup> occurrence(s), ` +
            `but the file no longer renders <DialogPopup> at all. Remove the stale entry.`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every manifest entry carries a real explanation, not a placeholder', () => {
    const offenders = DIALOG_PADDING_MANIFEST.filter(
      (entry) => entry.reason.trim().length < 40
    ).map(
      (entry) =>
        `${entry.file} (${entry.category}): reason is only ${entry.reason.trim().length} chars — write an actual explanation of why this file is classified that way.`
    );
    expect(offenders).toEqual([]);
  });

  describe('panel entries actually wrap their body in DialogPanel', () => {
    for (const entry of DIALOG_PADDING_MANIFEST.filter((e) => e.category === 'panel')) {
      const label = entry.marker ? `${entry.file} [${entry.marker}]` : entry.file;
      it(label, () => {
        const segment = segmentFor(readStripped(entry.file), entry.marker);
        const need = entry.occurrences ?? 1;
        const got = countLiteral(segment, '<DialogPanel');
        expect(
          got >= need,
          `${entry.file}: manifest says 'panel' (expects >= ${need} <DialogPanel> occurrence(s)) but found ` +
            `${got}. Either the DialogPanel wrap was removed from the body (put it back) or 'occurrences' on ` +
            `this manifest entry is now wrong.`
        ).toBe(true);
      });
    }
  });

  describe('manual entries carry both the padding class and a comment explaining why', () => {
    for (const entry of DIALOG_PADDING_MANIFEST.filter((e) => e.category === 'manual')) {
      it(entry.file, () => {
        const strippedSegment = segmentFor(readStripped(entry.file), entry.marker);
        const rawSegment = segmentFor(readRaw(entry.file), entry.marker);

        expect(
          hasPaddingToken(strippedSegment),
          `${entry.file}: manifest says 'manual' padding, but no px-6/p-6 class was found on the body. Add ` +
            `one, or switch the body to <DialogPanel> (the default) and reclassify this entry as 'panel'.`
        ).toBe(true);

        // Neither of these files imports the DialogPanel COMPONENT, so any
        // occurrence of the word is necessarily prose — proof a comment
        // exists explaining the manual padding rather than a silent choice.
        expect(
          rawSegment.includes('DialogPanel'),
          `${entry.file}: manifest says 'manual' padding, which requires a source comment explaining why ` +
            `DialogPanel isn't used here. No mention of "DialogPanel" was found near the body — add one ` +
            `(see LeftDock.tsx or CodeReviewModal.tsx for the shape this comment takes).`
        ).toBe(true);
      });
    }
  });

  describe('no-body entries have not silently grown an unwrapped body', () => {
    for (const entry of DIALOG_PADDING_MANIFEST.filter((e) => e.category === 'no-body')) {
      it(entry.file, () => {
        const segment = segmentFor(readStripped(entry.file), entry.marker);
        expect(
          segment.includes('<DialogPanel'),
          `${entry.file}: manifest says 'no-body' (header/footer only) but the file now contains ` +
            `<DialogPanel>. It grew a body — reclassify this entry as 'panel' rather than leaving it under ` +
            `'no-body' (the DialogPanel wrap is probably already correct; this test just needs to catch up).`
        ).toBe(false);
      });
    }
  });

  describe('custom entries are still genuinely header-less', () => {
    for (const entry of DIALOG_PADDING_MANIFEST.filter((e) => e.category === 'custom')) {
      const label = entry.marker ? `${entry.file} [${entry.marker}]` : entry.file;
      it(label, () => {
        const segment = segmentFor(readStripped(entry.file), entry.marker);
        expect(
          segment.includes('<DialogHeader'),
          `${entry.file}: manifest says 'custom' (no DialogHeader, so no 24px baseline to fall short of) but ` +
            `the file now contains <DialogHeader>. Re-examine this dialog: if it now has a real header + ` +
            `body, reclassify it as 'panel' or 'manual' instead of 'custom'.`
        ).toBe(false);
      });
    }
  });
});
