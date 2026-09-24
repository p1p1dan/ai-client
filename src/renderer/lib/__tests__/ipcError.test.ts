import { describe, expect, it } from 'vitest';
import { unwrapIpcErrorMessage } from '../ipcError';

/** Verbatim from the 2026-09-24 point-check B3 (`shots/30-b3-checkout-refused.png`). */
const CHECKOUT_REFUSAL =
  "Error invoking remote method 'git:branch:checkout': Error: error: Your local changes to the following files would be overwritten by checkout:\n\tshared.txt\nPlease commit your changes or stash them before you switch branches.\nAborting";

describe('unwrapIpcErrorMessage', () => {
  it("drops Electron's invoke wrapper and leaves git's own words", () => {
    expect(unwrapIpcErrorMessage(new Error(CHECKOUT_REFUSAL))).toBe(
      'error: Your local changes to the following files would be overwritten by checkout:\n\tshared.txt\nPlease commit your changes or stash them before you switch branches.\nAborting'
    );
  });

  it('drops a named error class the wrapper carried (WorkerManagerError: …)', () => {
    expect(
      unwrapIpcErrorMessage(
        new Error(
          "Error invoking remote method 'chat:compactSession': WorkerManagerError: Session s-1 cannot compact the conversation while active"
        )
      )
    ).toBe('Session s-1 cannot compact the conversation while active');
  });

  it('leaves a message that was never wrapped exactly as it was', () => {
    expect(unwrapIpcErrorMessage(new Error('fatal: not a git repository'))).toBe(
      'fatal: not a git repository'
    );
    expect(unwrapIpcErrorMessage('plain string')).toBe('plain string');
  });

  it('reads a missing reason as an empty string, not as "undefined"', () => {
    expect(unwrapIpcErrorMessage(undefined)).toBe('');
    expect(unwrapIpcErrorMessage(null)).toBe('');
  });
});
