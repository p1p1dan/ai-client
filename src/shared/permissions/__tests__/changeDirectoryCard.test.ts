import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';

/** Decision 207 §15, §14 G: the card a move out of the workspace raises. */
describe('the change-directory card', () => {
  it('is worded change_directory and names the directory, whichever tool asks', async () => {
    for (const tool of ['working_directory', 'subagent']) {
      const events: RuntimeEventDraft[] = [];
      const prompt = createPermissionPrompt({
        sessionId: 's1',
        cwd: '/ws',
        emit: (event) => events.push(event),
      });
      const answer = prompt.approve(
        {
          tool,
          toolCallId: 'd1',
          path: '/elsewhere/proj',
          policySurface: 'read',
          changeDirectory: true,
        },
        new AbortController().signal
      );
      expect(prompt.respond({ permissionId: 'd1', decision: 'allow' })).toBe(true);
      expect(await answer).toBe('allow-once');
      const requested = events.find((event) => event.type === 'permission.requested');
      expect(requested?.payload, tool).toMatchObject({
        toolName: tool,
        action: 'change_directory',
        kind: 'tool',
        input: { path: '/elsewhere/proj', workspace: '/ws' },
      });
    }
  });
});
