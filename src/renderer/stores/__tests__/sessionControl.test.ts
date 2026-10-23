import { describe, expect, it } from 'vitest';
import { applySessionControlChange, useSessionControlStore } from '../sessionControl';

describe('session control mirror (plugin-system §4)', () => {
  it('[PLG-CONTROL-UI] lists sessions a client holds and drops them when the desktop takes back', () => {
    applySessionControlChange({
      sessionId: 's1',
      controller: {
        kind: 'client',
        ownerId: -1,
        pluginId: 'pilab.remote-access',
        label: '网页 · iPhone',
      },
    });
    expect(useSessionControlStore.getState().remote).toEqual({
      s1: { label: '网页 · iPhone', pluginId: 'pilab.remote-access' },
    });
    applySessionControlChange({ sessionId: 's1', controller: { kind: 'desktop' } });
    expect(useSessionControlStore.getState().remote).toEqual({});
  });
});
