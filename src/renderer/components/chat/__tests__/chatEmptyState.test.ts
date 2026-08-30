import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ChatEmptyStateInput, deriveChatEmptySurface } from '../chatEmptyState';
import { stripComments } from './stripComments';

/**
 * T12-e — "cannot send yet" is not one state, and it never was.
 *
 * All four conditions used to render the SAME red monospace box with
 * developer-facing text (`No repository registered — launch with
 * --open-path=<repo> …`). On a fresh install that box is permanently lit,
 * which is the user report this split answers: it reads as a fault, not as a
 * setup step, and it names a CLI flag a desktop user will never type.
 */

function input(overrides: Partial<ChatEmptyStateInput> = {}): ChatEmptyStateInput {
  return { hasError: false, hasSession: true, hasWorkspace: true, hasCwd: true, ...overrides };
}

describe('deriveChatEmptySurface', () => {
  it('shows nothing when the composer can send', () => {
    expect(deriveChatEmptySurface(input())).toBe('none');
  });

  it('guides instead of alarming when there is simply no folder yet', () => {
    expect(deriveChatEmptySurface(input({ hasWorkspace: false, hasCwd: false }))).toBe('welcome');
  });

  it('treats a present-but-untargetable workspace as "no folder", not a fault', () => {
    // The demo placeholder carries an EMPTY path on purpose, so a fake cwd can
    // never reach spawn. That is a setup gap, not something going wrong.
    expect(deriveChatEmptySurface(input({ hasWorkspace: true, hasCwd: false }))).toBe('welcome');
  });

  it('keeps the red box for a real error', () => {
    expect(deriveChatEmptySurface(input({ hasError: true }))).toBe('error-notice');
  });

  it('lets a real error outrank the welcome card', () => {
    // The load-bearing ordering. A failure raised while no folder is set must
    // not be swallowed by a cheerful card that has no way to mention it.
    expect(
      deriveChatEmptySurface(input({ hasError: true, hasWorkspace: false, hasCwd: false }))
    ).toBe('error-notice');
  });

  it('keeps the diagnostic for a missing session', () => {
    // "Add a working directory" does not fix a missing session, so this one
    // stays a diagnostic rather than becoming guidance that cannot help.
    expect(deriveChatEmptySurface(input({ hasSession: false }))).toBe('error-notice');
  });

  it('prefers the folder step when both the session and the folder are missing', () => {
    // Ordering again, the other way round: of the two, picking a folder is the
    // step the user can actually take.
    expect(deriveChatEmptySurface(input({ hasSession: false, hasCwd: false }))).toBe('welcome');
  });
});

/**
 * The truth table above is worth nothing if the composer does not read it.
 * Deleting the `'welcome'` JSX branch — the whole point of this batch — leaves
 * every assertion above green, because they only exercise the pure function.
 * Source-scanned because these are JSX branches, which types cannot reach.
 *
 * Comments are stripped first: this file's own head note names the surfaces,
 * and a negative scan that matches its own prose is a test that passes for the
 * wrong reason (the repo has been bitten by this three times — see the 0820
 * batch's §16 discipline note).
 */
describe('[T12-e wiring] the composer actually renders both surfaces', () => {
  const COMPOSER = path.join(__dirname, '..', 'ChatComposer.tsx');
  const SOURCE = stripComments(readFileSync(COMPOSER, 'utf8'), 'ChatComposer.tsx');

  it('derives the surface from the shared function, not a second hand-written condition', () => {
    expect(SOURCE).toContain('deriveChatEmptySurface(');
    // The original disjunction must be GONE, not merely unused: two conditions
    // that answer the same question drift, and F14 minor m2 is the recorded
    // instance of exactly that drift in exactly this file.
    expect(SOURCE).not.toContain('lastError || !activeSessionId || !activeWorkspace || !cwd');
  });

  it('renders the welcome card on the welcome surface', () => {
    expect(SOURCE).toContain("emptySurface === 'welcome'");
    expect(SOURCE).toContain('<ChatWelcomeCard');
  });

  it('still renders the red diagnostic box on the error surface', () => {
    // The half that must NOT be lost while making the other half friendlier.
    expect(SOURCE).toContain("emptySurface === 'error-notice'");
    expect(SOURCE).toContain('border-destructive/40');
  });

  it('tells the placeholder about the missing directory too', () => {
    // Found by looking at the screen, not by an assertion: with the card up,
    // the textarea still read `Cannot send right now…` — the terminal
    // fall-through of `composerPlaceholder`'s ladder, which had branches for
    // "no session" and "no workspace" but none for "workspace with no path".
    // So the least informative string in that function was what a FRESH
    // INSTALL saw.
    expect(SOURCE).toContain('hasCwd: Boolean(cwd)');
  });

  it('passes the add-repository handler through, so the button is not dead', () => {
    // A guided card whose only control does nothing is worse than the red box
    // it replaced — that box at least told the truth.
    expect(SOURCE).toMatch(/<ChatWelcomeCard[\s\S]{0,200}onAddRepository=\{onAddRepository\}/);
  });
});
