import { describe, expect, it, vi } from 'vitest';
import { deferRootUnmount } from '../deferRootUnmount';

function createSchedule() {
  return vi.fn<(cb: () => void) => void>();
}

function createRoot() {
  return { unmount: vi.fn() };
}

describe('deferRootUnmount', () => {
  it('never unmounts synchronously', () => {
    const root = createRoot();
    const schedule = createSchedule();

    deferRootUnmount([root], schedule);

    expect(root.unmount).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('unmounts every root exactly once when the scheduled callback runs', () => {
    const first = createRoot();
    const second = createRoot();
    const schedule = createSchedule();

    deferRootUnmount([first, second], schedule);
    schedule.mock.calls[0][0]();

    expect(first.unmount).toHaveBeenCalledTimes(1);
    expect(second.unmount).toHaveBeenCalledTimes(1);
  });

  it('tolerates null and undefined entries', () => {
    const root = createRoot();
    const schedule = createSchedule();

    deferRootUnmount([null, root, undefined], schedule);
    schedule.mock.calls[0][0]();

    expect(root.unmount).toHaveBeenCalledTimes(1);
  });

  it('does not schedule anything when no root is left to unmount', () => {
    const schedule = createSchedule();

    deferRootUnmount([null, undefined], schedule);
    deferRootUnmount([], schedule);

    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps unmounting the remaining roots when one throws', () => {
    const failing = {
      unmount: vi.fn(() => {
        throw new Error('already unmounted');
      }),
    };
    const survivor = createRoot();
    const schedule = createSchedule();

    deferRootUnmount([failing, survivor], schedule);

    expect(() => schedule.mock.calls[0][0]()).not.toThrow();
    expect(failing.unmount).toHaveBeenCalledTimes(1);
    expect(survivor.unmount).toHaveBeenCalledTimes(1);
  });
});
