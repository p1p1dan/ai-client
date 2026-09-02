import { TASK_COMPLETION_MARKER } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildAutoExecutePrompt, hasCompletedAutoExecuteOutput } from '../autoExecuteMarker';

describe('Pi TUI auto execute marker', () => {
  it('does not complete when the TUI only echoes the submitted instruction', () => {
    const prompt = buildAutoExecutePrompt('Run tests');
    expect(prompt).toContain(TASK_COMPLETION_MARKER);
    expect(hasCompletedAutoExecuteOutput(prompt)).toBe(false);
  });

  it('completes when Pi emits the marker after the echoed prompt', () => {
    const output = `${buildAutoExecutePrompt('Run tests')}\nwork done\n${TASK_COMPLETION_MARKER}\n`;
    expect(hasCompletedAutoExecuteOutput(output)).toBe(true);
  });

  it('handles a marker split across PTY chunks once the output is joined', () => {
    const prompt = buildAutoExecutePrompt('Run tests');
    const split = TASK_COMPLETION_MARKER.length / 2;
    const output = `${prompt}\n${TASK_COMPLETION_MARKER.slice(0, split)}${TASK_COMPLETION_MARKER.slice(split)}`;
    expect(hasCompletedAutoExecuteOutput(output)).toBe(true);
  });
});
