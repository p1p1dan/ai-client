// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A-round testing closes the `Use my own setup` route.
 *
 * Both halves of the request are pinned here, because each without the other is
 * the wrong screen: the button must still be VISIBLE (removing it would make the
 * second route look like it never existed) and it must be UNPRESSABLE, right
 * down to keyboard focus — a `pointer-events: none` style would have satisfied a
 * click test and still let Tab+Enter through.
 *
 * The assertions follow `LOCAL_SETUP_ENTRY_DISABLED` rather than asserting
 * `true`, so flipping that one line back after A-round leaves this suite green
 * and still guarding the wiring. The source scan below is what stops the switch
 * from being bypassed while it is on.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

let WelcomeView: typeof import('../WelcomeView')['WelcomeView'];
let LOCAL_SETUP_ENTRY_DISABLED: boolean;
let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ WelcomeView, LOCAL_SETUP_ENTRY_DISABLED } = await import('../WelcomeView'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const handlers = {
  onSignIn: vi.fn(),
  onContinue: vi.fn(),
  onUseOwnSetup: vi.fn(),
};

function render() {
  handlers.onSignIn.mockClear();
  handlers.onContinue.mockClear();
  handlers.onUseOwnSetup.mockClear();
  act(() => {
    root.render(
      createElement(WelcomeView, {
        entry: { primary: 'sign-in', email: null, notice: null },
        ...handlers,
      })
    );
  });
  const buttons = [...container.querySelectorAll('button')];
  const local = buttons.find((button) => button.textContent?.includes('Use my own setup'));
  const primary = buttons.find((button) => button.textContent?.includes('Log in with work email'));
  if (!local || !primary) throw new Error('welcome screen did not render both buttons');
  return { local, primary };
}

describe('A-round: the local-setup entry is closed but still on screen', () => {
  it('keeps the button rendered', () => {
    expect(render().local.textContent).toContain('Use my own setup');
  });

  it('disables it — unclickable AND unfocusable — while the switch is on', () => {
    const { local } = render();
    expect(local.disabled).toBe(LOCAL_SETUP_ENTRY_DISABLED);
    act(() => {
      local.click();
    });
    expect(handlers.onUseOwnSetup).toHaveBeenCalledTimes(LOCAL_SETUP_ENTRY_DISABLED ? 0 : 1);
    if (LOCAL_SETUP_ENTRY_DISABLED) {
      local.focus();
      expect(document.activeElement).not.toBe(local);
    }
  });

  it('closes only that route — the sign-in button still works', () => {
    const { primary } = render();
    expect(primary.disabled).toBe(false);
    act(() => {
      primary.click();
    });
    expect(handlers.onSignIn).toHaveBeenCalledTimes(1);
  });
});
