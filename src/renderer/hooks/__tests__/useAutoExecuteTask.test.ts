import { TASK_COMPLETION_MARKER } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildAutoExecutePrompt,
  createAutoExecuteCompletionTracker,
  hasCompletedAutoExecuteOutput,
} from '../autoExecuteMarker';

function completedOutput(title: string): string {
  return `${buildAutoExecutePrompt(title)}\nwork done\n${TASK_COMPLETION_MARKER}\n`;
}

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

describe('Pi TUI auto execute completion tracker', () => {
  it('settles each queued task, not just the first one', () => {
    const tracker = createAutoExecuteCompletionTracker();

    expect(tracker.data('session-1', completedOutput('First task'))).toBe(true);
    // Same queue run, next task: a fresh session must be able to settle too.
    expect(tracker.data('session-2', completedOutput('Second task'))).toBe(true);
    expect(tracker.exit('session-3')).toBe(true);
  });

  it('settles a task once, ignoring the trailing output of a finished session', () => {
    const tracker = createAutoExecuteCompletionTracker();

    expect(tracker.data('session-1', completedOutput('First task'))).toBe(true);
    expect(tracker.data('session-1', `more output\n${TASK_COMPLETION_MARKER}\n`)).toBe(false);
    expect(tracker.exit('session-1')).toBe(false);
  });

  it('does not carry one task’s buffered markers into the next task', () => {
    const tracker = createAutoExecuteCompletionTracker();

    // One marker only: the echoed prompt, no completion yet.
    expect(tracker.data('session-1', buildAutoExecutePrompt('First task'))).toBe(false);
    // The next task's echoed prompt would be the second marker overall if the
    // buffer were shared, completing task #2 before Pi has done any work.
    expect(tracker.data('session-2', buildAutoExecutePrompt('Second task'))).toBe(false);
  });
});
