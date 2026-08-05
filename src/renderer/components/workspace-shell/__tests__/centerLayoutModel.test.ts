import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  chatWidthToEditorRatio,
  clampEditorRatio,
  DEFAULT_EDITOR_RATIO,
  deriveChatVisible,
  deriveEditorOpen,
  derivePanelVisible,
  EDITOR_MIN_WIDTH,
  LEVEL_L0_MIN_CONTENT,
  LEVEL_L1_MIN_CONTENT,
  MAX_EDITOR_RATIO,
  MIN_EDITOR_RATIO,
  resolveChatColumnWidth,
  resolveShellLevel,
} from '../centerLayoutModel';

describe('clampEditorRatio', () => {
  it('keeps a ratio inside 0.25..0.75', () => {
    expect(clampEditorRatio(0.5)).toBe(0.5);
    expect(clampEditorRatio(0.1)).toBe(MIN_EDITOR_RATIO);
    expect(clampEditorRatio(0.99)).toBe(MAX_EDITOR_RATIO);
  });

  it('falls back to the default for anything non-finite', () => {
    expect(clampEditorRatio(Number.NaN)).toBe(DEFAULT_EDITOR_RATIO);
    expect(clampEditorRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EDITOR_RATIO);
    expect(clampEditorRatio(undefined as unknown as number)).toBe(DEFAULT_EDITOR_RATIO);
  });
});

describe('resolveChatColumnWidth', () => {
  const roomy = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + 400; // 1320

  it('splits the row by the ratio when the ratio is reachable', () => {
    // 2000 wide: chat may run 400..1480, so a 0.5 split is reachable.
    expect(resolveChatColumnWidth({ centerWidth: 2000, editorRatio: 0.5 })).toBe(1000);
    expect(resolveChatColumnWidth({ centerWidth: 2000, editorRatio: 0.6 })).toBe(800);
  });

  it('lets the editor floor beat the persisted ratio, not the other way round', () => {
    // The floors are hard and the ratio is a preference. At 1000 wide a 0.5
    // split wants 500 for chat, but that leaves the editor 500 — under its
    // 520 floor — so chat gets 480 instead. The persisted ratio is NOT
    // rewritten; widen the window and the 0.5 split comes back.
    expect(resolveChatColumnWidth({ centerWidth: 1000, editorRatio: 0.5 })).toBe(480);
    expect(resolveChatColumnWidth({ centerWidth: roomy, editorRatio: 0.25 })).toBe(
      roomy - EDITOR_MIN_WIDTH
    );
  });

  it('keeps the editor at or above its floor for every width where chat renders', () => {
    // "Where chat renders" is the qualifier that matters: at or above the L1
    // threshold both floors fit, so neither column is ever squeezed. Below it
    // the ladder is at L2 and chat is not rendered at all, which is why
    // `resolveChatColumnWidth` may stop honouring the editor floor down there.
    for (const centerWidth of [920, 1000, 1320, 2400]) {
      const chat = resolveChatColumnWidth({ centerWidth, editorRatio: MIN_EDITOR_RATIO });
      expect(chat).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
      expect(centerWidth - chat).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
    }
  });

  it('holds chat`s floor while there is room for both', () => {
    const width = resolveChatColumnWidth({ centerWidth: 1000, editorRatio: MAX_EDITOR_RATIO });
    expect(width).toBe(CHAT_MIN_WIDTH);
  });

  it('NEVER squeezes chat below its floor — the ladder hides it instead (m-T32)', () => {
    // User report: 「聊天页面极度变形」. 800 < 400 + 520, and the old behaviour
    // handed chat the 280px shortfall. A deformed strip is worse than no
    // strip: at this width `resolveShellLevel` is already L2, so chat is not
    // rendered at all — and if it ever is, it is readable.
    for (const centerWidth of [800, 700, EDITOR_MIN_WIDTH, 100]) {
      expect(resolveChatColumnWidth({ centerWidth, editorRatio: 0.5 })).toBeGreaterThanOrEqual(
        CHAT_MIN_WIDTH
      );
    }
  });

  it('hands the shortfall to the editor, which can scroll, not to chat', () => {
    expect(resolveChatColumnWidth({ centerWidth: 800, editorRatio: 0.5 })).toBe(CHAT_MIN_WIDTH);
  });

  it('falls back to the chat floor before the first measurement', () => {
    expect(resolveChatColumnWidth({ centerWidth: 0, editorRatio: 0.5 })).toBe(CHAT_MIN_WIDTH);
    expect(resolveChatColumnWidth({ centerWidth: Number.NaN, editorRatio: 0.5 })).toBe(
      CHAT_MIN_WIDTH
    );
  });
});

describe('chatWidthToEditorRatio', () => {
  it('inverts resolveChatColumnWidth for every ratio that row can actually reach', () => {
    // At 1600 the reachable band is 0.325 (chat pinned at 1600-520) to 0.75
    // (chat pinned at its own 400 floor). Inside it the round trip is exact;
    // outside it `resolveChatColumnWidth` has already clamped, so asking the
    // inverse to return the unreachable input would be asserting a lie.
    const centerWidth = 1600;
    for (const ratio of [0.4, 0.5, 0.6, 0.75]) {
      const width = resolveChatColumnWidth({ centerWidth, editorRatio: ratio });
      expect(chatWidthToEditorRatio({ chatWidth: width, centerWidth })).toBeCloseTo(ratio, 2);
    }
  });

  it('clamps a drag past either end instead of persisting an unusable ratio', () => {
    expect(chatWidthToEditorRatio({ chatWidth: 1590, centerWidth: 1600 })).toBe(MIN_EDITOR_RATIO);
    expect(chatWidthToEditorRatio({ chatWidth: 10, centerWidth: 1600 })).toBe(MAX_EDITOR_RATIO);
  });

  it('falls back to the default for an unmeasured row', () => {
    expect(chatWidthToEditorRatio({ chatWidth: 500, centerWidth: 0 })).toBe(DEFAULT_EDITOR_RATIO);
    expect(chatWidthToEditorRatio({ chatWidth: Number.NaN, centerWidth: 1600 })).toBe(
      DEFAULT_EDITOR_RATIO
    );
  });
});

describe('deriveEditorOpen', () => {
  it('is true from the first tab, before one is active', () => {
    expect(deriveEditorOpen(0)).toBe(false);
    expect(deriveEditorOpen(1)).toBe(true);
    expect(deriveEditorOpen(7)).toBe(true);
  });

  it('is false for garbage counts rather than throwing', () => {
    expect(deriveEditorOpen(Number.NaN)).toBe(false);
    expect(deriveEditorOpen(-1)).toBe(false);
  });
});

// ── the level ladder (S4) ───────────────────────────────────────────────

describe('resolveShellLevel', () => {
  it('is always L0 with no file open, at any width (A08 gates the ladder on `editor open`)', () => {
    for (const contentWidth of [320, 700, 963, 1299, 4000]) {
      expect(resolveShellLevel({ contentWidth, editorOpen: false })).toBe('L0');
    }
  });

  it('walks L0 → L1 → L2 as the content row narrows, with a file open', () => {
    expect(resolveShellLevel({ contentWidth: LEVEL_L0_MIN_CONTENT, editorOpen: true })).toBe('L0');
    expect(resolveShellLevel({ contentWidth: LEVEL_L0_MIN_CONTENT - 1, editorOpen: true })).toBe(
      'L1'
    );
    expect(resolveShellLevel({ contentWidth: LEVEL_L1_MIN_CONTENT, editorOpen: true })).toBe('L1');
    expect(resolveShellLevel({ contentWidth: LEVEL_L1_MIN_CONTENT - 1, editorOpen: true })).toBe(
      'L2'
    );
  });

  it('assumes roomy before the first measurement rather than flashing a degraded layout', () => {
    expect(resolveShellLevel({ contentWidth: null, editorOpen: true })).toBe('L0');
    expect(resolveShellLevel({ contentWidth: 0, editorOpen: true })).toBe('L0');
  });

  it('derives its thresholds from the same floors the column widths use', () => {
    // A08 states 1580/1244 as WHOLE-WINDOW widths. Ours measure the content
    // row, which excludes the sidebar (draggable 280-500, collapsible to 48)
    // at both rungs, and ALSO excludes the rail at L1 — the rail is a sibling
    // of the measured row, so counting it here would double it (m-T32 fix).
    expect(LEVEL_L0_MIN_CONTENT + 280).toBe(1580); // 1580 = 280 sidebar + row
    expect(LEVEL_L1_MIN_CONTENT + 280 + 44).toBe(1244); // 1244 = 280 + row + 44 rail
    expect(LEVEL_L0_MIN_CONTENT).toBe(CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + 380);
    expect(LEVEL_L1_MIN_CONTENT).toBe(CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH);
  });

  it('drops to L2 exactly where both floors stop fitting', () => {
    // The contract that lets resolveChatColumnWidth keep chat readable: below
    // this width chat is not rendered, so it never needs to shrink further.
    expect(
      resolveShellLevel({ contentWidth: CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH, editorOpen: true })
    ).toBe('L1');
    expect(
      resolveShellLevel({ contentWidth: CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH - 1, editorOpen: true })
    ).toBe('L2');
  });
});

describe('derivePanelVisible', () => {
  const base = { level: 'L0' as const, editorOpen: true, panelOpen: true, manualPanel: null };

  it('follows the user preference verbatim when no file is open', () => {
    expect(derivePanelVisible({ ...base, editorOpen: false, panelOpen: true })).toBe(true);
    expect(derivePanelVisible({ ...base, editorOpen: false, panelOpen: false })).toBe(false);
    // Even at L2 — the ladder does not run without an editor.
    expect(derivePanelVisible({ ...base, level: 'L2', editorOpen: false, panelOpen: true })).toBe(
      true
    );
  });

  it('gives the panel up at L1 and below when a file is open', () => {
    expect(derivePanelVisible({ ...base, level: 'L0' })).toBe(true);
    expect(derivePanelVisible({ ...base, level: 'L1' })).toBe(false);
    expect(derivePanelVisible({ ...base, level: 'L2' })).toBe(false);
  });

  it('lets a manual override beat the ladder in both directions', () => {
    expect(derivePanelVisible({ ...base, level: 'L2', manualPanel: true })).toBe(true);
    expect(derivePanelVisible({ ...base, level: 'L0', manualPanel: false })).toBe(false);
  });

  it('treats a cleared override as absent, not as "hidden"', () => {
    // The whole reason ManualOverride is `boolean | null`: after a file closes
    // the override is cleared, and `false` would keep the panel hidden forever.
    expect(derivePanelVisible({ ...base, editorOpen: false, manualPanel: null })).toBe(true);
  });
});

describe('deriveChatVisible', () => {
  const base = { level: 'L0' as const, editorOpen: true, manualChat: null };

  it('never hides chat when no file is open — chat IS the shell then', () => {
    for (const level of ['L0', 'L1', 'L2'] as const) {
      expect(deriveChatVisible({ ...base, level, editorOpen: false })).toBe(true);
    }
  });

  it('only gives chat up at L2', () => {
    expect(deriveChatVisible({ ...base, level: 'L0' })).toBe(true);
    expect(deriveChatVisible({ ...base, level: 'L1' })).toBe(true);
    expect(deriveChatVisible({ ...base, level: 'L2' })).toBe(false);
  });

  it('honours the「隐去 chat」override at any level, and the un-hide too', () => {
    expect(deriveChatVisible({ ...base, level: 'L0', manualChat: false })).toBe(false);
    expect(deriveChatVisible({ ...base, level: 'L2', manualChat: true })).toBe(true);
  });
});

describe('ladder composition (the combinations that actually ship)', () => {
  it('L1 with a file open = editor + chat, no panel; the rail comes back', () => {
    const level = resolveShellLevel({ contentWidth: 1000, editorOpen: true });
    expect(level).toBe('L1');
    expect(
      derivePanelVisible({ level, editorOpen: true, panelOpen: true, manualPanel: null })
    ).toBe(false);
    expect(deriveChatVisible({ level, editorOpen: true, manualChat: null })).toBe(true);
  });

  it('L2 with a file open = editor only', () => {
    const level = resolveShellLevel({ contentWidth: 800, editorOpen: true });
    expect(level).toBe('L2');
    expect(
      derivePanelVisible({ level, editorOpen: true, panelOpen: true, manualPanel: null })
    ).toBe(false);
    expect(deriveChatVisible({ level, editorOpen: true, manualChat: null })).toBe(false);
  });

  it('closing the file restores the user preference, whatever the ladder had done', () => {
    // The bug this pins: if the ladder had written the preference instead of
    // composing over it, a narrow window would leave the panel off for good.
    const narrow = resolveShellLevel({ contentWidth: 800, editorOpen: true });
    expect(
      derivePanelVisible({ level: narrow, editorOpen: true, panelOpen: true, manualPanel: null })
    ).toBe(false);

    const closed = resolveShellLevel({ contentWidth: 800, editorOpen: false });
    expect(
      derivePanelVisible({ level: closed, editorOpen: false, panelOpen: true, manualPanel: null })
    ).toBe(true);
  });
});
