import type { SessionTreeNode } from '@shared/types/sessionHistory';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatSessions';
import {
  FORK_NOT_MATERIALIZED,
  PROMPT_ENTRY_NOT_FOUND,
  type PromptActionDeps,
  promptTreePreview,
  resolvePromptEntryId,
  runEditAndResend,
  runForkFromPrompt,
  userMessageActionFailure,
  userMessageActions,
  userMessageCopyText,
} from '../userMessageActionsModel';

/** Issue #26 item 1: the user message's hover actions. */

function prompt(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 's',
    role: 'user',
    blocks: [{ id: `${id}-text`, type: 'text', text }],
    ...extra,
  };
}

function node(id: string, preview: string, extra: Partial<SessionTreeNode> = {}): SessionTreeNode {
  return {
    id,
    parentId: null,
    depth: 0,
    entryType: 'message',
    role: 'user',
    preview,
    childCount: 0,
    forkable: true,
    active: true,
    leaf: false,
    ...extra,
  };
}

describe('which actions a message offers', () => {
  const base = { engine: undefined, hasDurableSession: true, idle: true, pending: false };

  it('DSH: copy, edit & resend and fork', () => {
    expect(userMessageActions(base)).toEqual({ copy: true, edit: true, fork: true });
  });

  it('the Claude SDK engine has no session tree: copy only', () => {
    expect(userMessageActions({ ...base, engine: 'claude-sdk' })).toEqual({
      copy: true,
      edit: false,
      fork: false,
    });
  });

  it('no durable session, or a message still on its way: copy only', () => {
    expect(userMessageActions({ ...base, hasDurableSession: false }).edit).toBe(false);
    expect(userMessageActions({ ...base, pending: true }).fork).toBe(false);
  });

  it('mid-run the actions stay offered (disabled by the caller), not hidden', () => {
    expect(userMessageActions({ ...base, idle: false })).toEqual({
      copy: true,
      edit: true,
      fork: true,
    });
  });
});

describe('copy text and the tree preview', () => {
  it('copies the prompt as typed, its paragraphs kept', () => {
    const message: ChatMessage = {
      ...prompt('u', 'first\n\nsecond'),
      blocks: [
        { id: 'a', type: 'text', text: 'first\n\nsecond' },
        { id: 'b', type: 'text', text: 'third' },
      ],
    };
    expect(userMessageCopyText(message)).toBe('first\n\nsecond\nthird');
  });

  it('previews as the DSH tree does: whitespace collapsed, capped at 96', () => {
    expect(promptTreePreview(prompt('u', '  a\n\n b  '))).toBe('a b');
    const long = promptTreePreview(prompt('u', 'x'.repeat(200)));
    expect(long).toHaveLength(96);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('resolvePromptEntryId', () => {
  it('a replayed message carries its entry', () => {
    expect(resolvePromptEntryId(prompt('h:m1', 'hi', { entryId: 'm1' }), [], [])).toBe('m1');
  });

  it('a live message is found by preview, counted from the end', () => {
    const timeline = [prompt('a', 'again'), prompt('b', 'other'), prompt('c', 'again')];
    const nodes = [
      node('n1', 'again'),
      node('r1', 'reply', { role: 'assistant' }),
      node('n2', 'other'),
      node('n3', 'again'),
    ];
    expect(resolvePromptEntryId(timeline[2] as ChatMessage, timeline, nodes)).toBe('n3');
    expect(resolvePromptEntryId(timeline[0] as ChatMessage, timeline, nodes)).toBe('n1');
    expect(resolvePromptEntryId(timeline[1] as ChatMessage, timeline, nodes)).toBe('n2');
  });

  it('only the active path counts, and a timeline holding only the latest page still matches', () => {
    // The tree holds an older 'again' the timeline has not paged in.
    const timeline = [prompt('c', 'again')];
    const nodes = [
      node('old', 'again'),
      node('branch', 'again', { active: false }),
      node('n3', 'again'),
    ];
    expect(resolvePromptEntryId(timeline[0] as ChatMessage, timeline, nodes)).toBe('n3');
  });

  it('an engine-started head is not a prompt', () => {
    const head = prompt('h', 'again', { origin: { kind: 'job' } });
    const timeline = [prompt('a', 'again'), head];
    const nodes = [node('n1', 'again')];
    expect(resolvePromptEntryId(timeline[0] as ChatMessage, timeline, nodes)).toBe('n1');
  });

  it('null when the tree does not hold it', () => {
    const timeline = [prompt('a', 'new')];
    expect(resolvePromptEntryId(timeline[0] as ChatMessage, timeline, [node('n', 'x')])).toBeNull();
  });
});

function fakeDeps(overrides: Partial<PromptActionDeps> = {}): PromptActionDeps {
  return {
    afterStart: (operation) => operation(),
    getSessionTree: vi.fn(async () => ({ snapshot: { nodes: [node('n1', 'hello')] } })),
    rewindSession: vi.fn(async () => ({ editorText: 'hello from the worker' })),
    forkSession: vi.fn(async () => ({ session: { id: 'fork' } })),
    resetSession: vi.fn(),
    offerText: vi.fn(),
    focusComposer: vi.fn(),
    materializeFork: vi.fn(() => true),
    ...overrides,
  };
}

describe('edit & resend', () => {
  it('rewinds to the prompt and offers the worker’s text to this chat’s composer', async () => {
    const deps = fakeDeps();
    const message = prompt('h:m1', 'hello', { entryId: 'm1' });
    await runEditAndResend(deps, 's', message, [message]);
    expect(deps.getSessionTree).not.toHaveBeenCalled();
    expect(deps.rewindSession).toHaveBeenCalledWith('s', 'm1');
    expect(deps.resetSession).toHaveBeenCalledWith('s');
    expect(deps.offerText).toHaveBeenCalledWith('s', 'hello from the worker');
    expect(deps.focusComposer).toHaveBeenCalledWith('s');
  });

  it('a live message reads the tree for its entry first', async () => {
    const deps = fakeDeps();
    const message = prompt('dsh-user-3', 'hello');
    await runEditAndResend(deps, 's', message, [message]);
    expect(deps.rewindSession).toHaveBeenCalledWith('s', 'n1');
  });

  it('falls back to the bubble’s own text when the worker hands none back', async () => {
    const deps = fakeDeps({ rewindSession: vi.fn(async () => ({})) });
    const message = prompt('h:m1', 'typed', { entryId: 'm1' });
    await runEditAndResend(deps, 's', message, [message]);
    expect(deps.offerText).toHaveBeenCalledWith('s', 'typed');
  });

  it('a message the tree does not hold is refused before any rewind', async () => {
    const deps = fakeDeps({ getSessionTree: vi.fn(async () => ({ snapshot: { nodes: [] } })) });
    const message = prompt('dsh-user-3', 'hello');
    await expect(runEditAndResend(deps, 's', message, [message])).rejects.toThrow(
      PROMPT_ENTRY_NOT_FOUND
    );
    expect(deps.rewindSession).not.toHaveBeenCalled();
    expect(deps.offerText).not.toHaveBeenCalled();
  });
});

describe('fork from here', () => {
  it('forks at the prompt and shows the new chat', async () => {
    const deps = fakeDeps();
    const message = prompt('h:m1', 'hello', { entryId: 'm1' });
    await runForkFromPrompt(deps, 's', message, [message]);
    expect(deps.forkSession).toHaveBeenCalledWith('s', 'm1');
    expect(deps.materializeFork).toHaveBeenCalledWith({ id: 'fork' });
    expect(deps.offerText).not.toHaveBeenCalled();
  });

  it('a fork this window cannot show is a failure, not silence', async () => {
    const deps = fakeDeps({ materializeFork: vi.fn(() => false) });
    const message = prompt('h:m1', 'hello', { entryId: 'm1' });
    await expect(runForkFromPrompt(deps, 's', message, [message])).rejects.toThrow(
      FORK_NOT_MATERIALIZED
    );
  });
});

describe('failure wording', () => {
  it('names a running background job, and passes other sentences through', () => {
    expect(userMessageActionFailure(new Error('WORKER_REWIND_JOBS_RUNNING: busy')).translated).toBe(
      true
    );
    expect(userMessageActionFailure(new Error('boom'))).toEqual({
      text: 'boom',
      translated: false,
    });
    expect(userMessageActionFailure(new Error(PROMPT_ENTRY_NOT_FOUND)).translated).toBe(true);
  });
});
