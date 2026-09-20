// @vitest-environment happy-dom

import { zhTranslations } from '@shared/i18n';
import {
  CHAT_BODY_FONT_SIZE_MAX,
  CHAT_BODY_FONT_SIZE_MIN,
  CHAT_PROCESS_FONT_SIZE_MAX,
  CHAT_PROCESS_FONT_SIZE_MIN,
  DEFAULT_CHAT_BODY_FONT_SIZE,
  DEFAULT_CHAT_PROCESS_FONT_SIZE,
} from '@shared/types/chatTypography';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { ChatTypographySection } from '../ChatTypographySettings';

/**
 * T104 — the settings half of the chat area's two size tiers.
 *
 * Mounted rather than asserted as source text because the claim is about a
 * WRITE, and about a pair of writes: the two fields are clamped against each
 * other, the store may move the neighbour when one moves, and both inputs have
 * to end up showing the pair the store actually holds. None of that exists
 * until the controls are real.
 *
 * Only the section is mounted, not the whole Appearance page — the page carries
 * the background-image block, which reads paths off disk through IPC and has
 * nothing to do with these three controls.
 *
 * The `electronAPI` stub lives in `vi.hoisted` for the reason
 * `subagentPanelMount.test.ts` documents: importing `useSettingsStore` starts
 * zustand persist's rehydrate at module-evaluation time, and a stub installed
 * in `beforeEach` arrives after that promise has already been left unsettled —
 * the mount then hangs for ten seconds and reports nothing.
 */
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

const DEFAULTS = {
  chatFontFamily: '',
  chatBodyFontSize: DEFAULT_CHAT_BODY_FONT_SIZE,
  chatProcessFontSize: DEFAULT_CHAT_PROCESS_FONT_SIZE,
} as const;

async function mountSection() {
  // Without this React refuses to flush the render inside `act` (the warning
  // reads "not configured to support act"), the tree never commits, and every
  // interaction below silently does nothing — the same setup the other
  // happy-dom suites in this directory use.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChatTypographySection));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

/**
 * The three inputs, in DOM order: family, body size, process size. Found by
 * position rather than by label text, because the labels go through `t()` and
 * the point of these assertions is not the copy.
 */
function inputsOf(container: HTMLElement): HTMLInputElement[] {
  const all = Array.from(container.querySelectorAll<HTMLInputElement>('input'));
  expect(all.length, 'family + two sizes').toBe(3);
  return all;
}

/**
 * Type a value and commit it the way the control does (blur).
 *
 * The event is `focusout`, not `blur`: React 17+ attaches `onBlur` through its
 * own root listener for the BUBBLING variant, and a synthetic non-bubbling
 * `blur` event never reaches it — the handler would not run and every
 * assertion below would read the untouched store.
 */
async function commit(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

afterEach(() => {
  useSettingsStore.setState({ ...DEFAULTS });
});

describe('T104: chat typography settings section', () => {
  it('exists in the Appearance page and writes all three settings to the store', async () => {
    useSettingsStore.setState({ ...DEFAULTS });
    const { container, cleanup } = await mountSection();
    try {
      const [family, body, process_] = inputsOf(container);

      await commit(family, 'Georgia, serif');
      expect(useSettingsStore.getState().chatFontFamily).toBe('Georgia, serif');

      await commit(body, '20');
      expect(useSettingsStore.getState().chatBodyFontSize).toBe(20);

      await commit(process_, '14');
      expect(useSettingsStore.getState().chatProcessFontSize).toBe(14);
    } finally {
      await cleanup();
    }
  });

  it('clearing the family field is how the reader returns to the app font', async () => {
    // Empty is a REAL value for this field (unlike the terminal's), so the
    // write must go through rather than falling back to the old family.
    useSettingsStore.setState({ ...DEFAULTS, chatFontFamily: 'Georgia, serif' });
    const { container, cleanup } = await mountSection();
    try {
      const [family] = inputsOf(container);
      await commit(family, '   ');
      expect(useSettingsStore.getState().chatFontFamily).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('clamps the body size to its range instead of storing the typed number', async () => {
    useSettingsStore.setState({ ...DEFAULTS });
    const { container, cleanup } = await mountSection();
    try {
      const [, body] = inputsOf(container);

      await commit(body, String(CHAT_BODY_FONT_SIZE_MAX + 40));
      expect(useSettingsStore.getState().chatBodyFontSize).toBe(CHAT_BODY_FONT_SIZE_MAX);

      await commit(body, String(CHAT_BODY_FONT_SIZE_MIN - 20));
      expect(useSettingsStore.getState().chatBodyFontSize).toBe(CHAT_BODY_FONT_SIZE_MIN);
    } finally {
      await cleanup();
    }
  });

  it('clamps the process size to its range, whose floor is the CJK floor and not lower', async () => {
    // design-system.md: 10px may not carry Chinese, and the process rows carry
    // Chinese verbs. 12 is the deliberate stretch; anything below it is a
    // readability defect, so the floor is asserted as a number.
    expect(CHAT_PROCESS_FONT_SIZE_MIN).toBeGreaterThanOrEqual(12);
    useSettingsStore.setState({ ...DEFAULTS });
    const { container, cleanup } = await mountSection();
    try {
      const [, , process_] = inputsOf(container);

      await commit(process_, String(CHAT_PROCESS_FONT_SIZE_MAX + 30));
      const afterHigh = useSettingsStore.getState();
      expect(afterHigh.chatProcessFontSize).toBeLessThanOrEqual(CHAT_PROCESS_FONT_SIZE_MAX);
      expect(afterHigh.chatProcessFontSize).toBeLessThanOrEqual(afterHigh.chatBodyFontSize);

      await commit(process_, String(CHAT_PROCESS_FONT_SIZE_MIN - 6));
      expect(useSettingsStore.getState().chatProcessFontSize).toBe(CHAT_PROCESS_FONT_SIZE_MIN);
    } finally {
      await cleanup();
    }
  });

  it('pulls the process tier down with the body when the body is lowered below it', async () => {
    // "Process larger than the answer" is a broken screen, not a preference.
    useSettingsStore.setState({
      chatFontFamily: '',
      chatBodyFontSize: 20,
      chatProcessFontSize: 18,
    });
    const { container, cleanup } = await mountSection();
    try {
      const [, body, process_] = inputsOf(container);
      await commit(body, '13');

      expect(useSettingsStore.getState().chatBodyFontSize).toBe(13);
      expect(useSettingsStore.getState().chatProcessFontSize).toBe(13);
      // And the field shows it: a control still displaying 18 would be telling
      // the reader a lie about what the chat area is rendering at.
      expect(process_.value).toBe('13');
    } finally {
      await cleanup();
    }
  });

  it('refuses to store a process tier above the body tier', async () => {
    useSettingsStore.setState({ ...DEFAULTS, chatBodyFontSize: 14, chatProcessFontSize: 13 });
    const { container, cleanup } = await mountSection();
    try {
      const [, , process_] = inputsOf(container);
      await commit(process_, '19');

      const state = useSettingsStore.getState();
      expect(state.chatProcessFontSize).toBe(14);
      expect(state.chatBodyFontSize).toBe(14);
    } finally {
      await cleanup();
    }
  });

  it('[R5] is reachable from the Appearance page under a translated heading', async () => {
    // The section is only useful if the page renders it: `ChatTypographySection`
    // is a separate module from `AppearanceSettings`, so a dropped import would
    // leave every assertion above green while the controls never reach a user.
    // The heading is asserted in Chinese because that is what ships — an English
    // string on screen is a defect in this app, and `i18nCoverage.test.ts` only
    // covers keys that are actually used. The locale is pinned rather than left
    // to the environment default (`getDefaultLocale` reads the platform), so the
    // assertion tests the catalog rather than the machine this runs on.
    useSettingsStore.setState({ ...DEFAULTS, language: 'zh' });
    const { AppearanceSettings } = await import('../AppearanceSettings');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    try {
      await act(async () => {
        root.render(createElement(AppearanceSettings));
      });
      // `SettingsSectionBlock` renders the block title as an `<h3>`; the three
      // `SettingsRow` labels are inline spans, so the whole page's text is what
      // proves they are present.
      const headings = Array.from(container.querySelectorAll('h3'), (el) => el.textContent);
      expect(headings).toContain(zhTranslations['Chat area']);
      const text = container.textContent ?? '';
      expect(text).toContain(zhTranslations['Message text size']);
      expect(text).toContain(zhTranslations['Process text size']);
      expect(text).toContain(zhTranslations['Font family']);
      // The two size inputs carry the range as their own attributes.
      const numeric = Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="number"]')
      );
      expect(numeric.map((el) => el.min)).toEqual([
        String(CHAT_BODY_FONT_SIZE_MIN),
        String(CHAT_PROCESS_FONT_SIZE_MIN),
      ]);
      expect(numeric.map((el) => el.max)).toEqual([
        String(CHAT_BODY_FONT_SIZE_MAX),
        // The process control's ceiling is the BODY size as well as its own
        // range's top — the `max` attribute states the "process ≤ body" rule
        // where the reader can see it instead of only rejecting the value.
        String(Math.min(CHAT_PROCESS_FONT_SIZE_MAX, DEFAULT_CHAT_BODY_FONT_SIZE)),
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      useSettingsStore.setState({ ...DEFAULTS });
    }
  });

  it('renders a live preview whose two tiers carry the setting', async () => {
    useSettingsStore.setState({
      chatFontFamily: 'Georgia, serif',
      chatBodyFontSize: 22,
      chatProcessFontSize: 12,
    });
    const { container, cleanup } = await mountSection();
    try {
      const styled = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter((el) =>
        el.style.fontSize.startsWith('22px')
      );
      expect(styled.length, 'the body tier preview line').toBeGreaterThan(0);
      expect(styled.some((el) => el.style.fontFamily.includes('Georgia'))).toBe(true);
      expect(
        Array.from(container.querySelectorAll<HTMLElement>('[style]')).some(
          (el) => el.style.fontSize === '12px'
        ),
        'the process tier preview line'
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('keeps the mono line out of the family override, which is the code-block guarantee', async () => {
    // The chat area's family declaration only inherits into descendants with no
    // family of their own, so a code block keeps the app's mono stack. The
    // preview states that next to the two sans lines, where the promise is
    // made — the mono sample is the `font-mono` element, it carries no inline
    // style at all, and its size stays on `text-code`, which is what a chat
    // code block actually uses (the body tier moves only the sans prose).
    useSettingsStore.setState({
      chatFontFamily: 'Georgia, serif',
      chatBodyFontSize: DEFAULT_CHAT_BODY_FONT_SIZE,
      chatProcessFontSize: DEFAULT_CHAT_PROCESS_FONT_SIZE,
    });
    const { container, cleanup } = await mountSection();
    try {
      const mono = Array.from(container.querySelectorAll<HTMLElement>('.font-mono'));
      expect(mono.length, 'one mono sample line').toBe(1);
      expect(mono[0]?.style.fontFamily).toBe('');
      expect(mono[0]?.style.fontSize).toBe('');
      expect(mono[0]?.textContent).toContain('const answer');
      // The two sans lines, by contrast, DO carry both the family and the size.
      const sans = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter((el) =>
        el.style.fontFamily.includes('Georgia')
      );
      expect(sans.length).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
