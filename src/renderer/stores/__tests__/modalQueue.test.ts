import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeModalQueueId,
  releaseModalQueueSlot,
  requestModalQueueSlot,
  resetModalQueueForTests,
  useModalQueueStore,
} from '../modalQueue';

/**
 * Pure-logic coverage for the "one self-opening dialog at a time" queue
 * (2026-09-18 field report — see `modalQueue.ts`'s class comment). The React
 * wiring (`useModalQueueSlot`, and the two dialogs opening for real) is
 * covered separately in
 * `components/settings/__tests__/agentMigrationPromptModalQueue.test.ts`;
 * this file is only the priority/idempotence rules underneath it.
 */

beforeEach(() => {
  resetModalQueueForTests();
});

describe('activeModalQueueId', () => {
  it('is null when nobody wants the slot', () => {
    expect(activeModalQueueId({})).toBeNull();
  });

  it('picks the sole requester', () => {
    expect(activeModalQueueId({ updateNotification: true })).toBe('updateNotification');
  });

  it('picks the lowest-priority-number id regardless of object key order', () => {
    expect(
      activeModalQueueId({
        updateNotification: true,
        announcement: true,
        agentMigrationPrompt: true,
      })
    ).toBe('announcement');
    expect(activeModalQueueId({ agentMigrationPrompt: true, updateNotification: true })).toBe(
      'agentMigrationPrompt'
    );
  });
});

describe('requestModalQueueSlot / releaseModalQueueSlot', () => {
  it('adds and removes ids from the store', () => {
    requestModalQueueSlot('announcement');
    expect(useModalQueueStore.getState().wanted).toEqual({ announcement: true });

    releaseModalQueueSlot('announcement');
    expect(useModalQueueStore.getState().wanted).toEqual({});
  });

  it('requesting twice is a no-op, not a double entry', () => {
    requestModalQueueSlot('agentMigrationPrompt');
    const afterFirst = useModalQueueStore.getState().wanted;
    requestModalQueueSlot('agentMigrationPrompt');
    // Same reference: the second call must not have produced a new object,
    // i.e. must not have called `setState` at all.
    expect(useModalQueueStore.getState().wanted).toBe(afterFirst);
  });

  it('releasing an id nobody requested is a no-op', () => {
    const before = useModalQueueStore.getState().wanted;
    releaseModalQueueSlot('updateNotification');
    expect(useModalQueueStore.getState().wanted).toBe(before);
  });

  it('releasing the holder promotes the next-highest priority id', () => {
    requestModalQueueSlot('updateNotification');
    requestModalQueueSlot('announcement');
    requestModalQueueSlot('agentMigrationPrompt');
    expect(activeModalQueueId(useModalQueueStore.getState().wanted)).toBe('announcement');

    releaseModalQueueSlot('announcement');
    expect(activeModalQueueId(useModalQueueStore.getState().wanted)).toBe('agentMigrationPrompt');

    releaseModalQueueSlot('agentMigrationPrompt');
    expect(activeModalQueueId(useModalQueueStore.getState().wanted)).toBe('updateNotification');

    releaseModalQueueSlot('updateNotification');
    expect(activeModalQueueId(useModalQueueStore.getState().wanted)).toBeNull();
  });
});
