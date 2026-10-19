import { describe, expect, it } from 'vitest';
import { canMoveToBackground } from '../toolBackground';

/** Decision 203: which running rows offer 「转到后台」. */
describe('canMoveToBackground', () => {
  const running = { running: true, toolName: 'Bash', toolCallId: 'toolu_1' } as const;

  it('a running shell command or subagent of a Claude engine chat', () => {
    for (const toolName of ['Bash', 'PowerShell', 'Agent', 'Task']) {
      expect(canMoveToBackground({ ...running, toolName }, 'claude-sdk')).toBe(true);
    }
  });

  it('never on DSH, which has no hand-over', () => {
    expect(canMoveToBackground(running, undefined)).toBe(false);
    expect(canMoveToBackground({ ...running, toolName: 'bash' }, undefined)).toBe(false);
  });

  it('not once it ended, already runs in the background, or is another tool', () => {
    expect(canMoveToBackground({ ...running, running: false }, 'claude-sdk')).toBe(false);
    expect(
      canMoveToBackground({ ...running, backgroundJob: { promoted: false } }, 'claude-sdk')
    ).toBe(false);
    expect(canMoveToBackground({ ...running, toolName: 'Read' }, 'claude-sdk')).toBe(false);
    expect(canMoveToBackground({ ...running, toolCallId: undefined }, 'claude-sdk')).toBe(false);
  });
});
