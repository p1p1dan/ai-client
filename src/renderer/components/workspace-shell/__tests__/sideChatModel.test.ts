import { describe, expect, it } from 'vitest';
import { resolveSessionRailVisibility } from '../sessionRail/sessionRailModel';
import {
  addSideQuestion,
  closeSideChat,
  INITIAL_SIDE_CHAT,
  openSideChat,
  pendingSideQuestionIds,
  pruneSideChat,
  resolveSideChatPlacement,
  SIDE_CHAT_DOCK_WIDTH,
  SIDE_CHAT_MIN_CHAT_WIDTH,
  setSideChatForm,
  settleSideQuestion,
  sideChatBusy,
  sideQuestionHistory,
  toggleSideChat,
} from '../sideChat/sideChatModel';

/**
 * Layout 5f (ui-cohesion ruling L6), reshaped by decision 209 §3: the side
 * chat's rules — open / its own window / dock / close, which conversation it
 * reads (it stays on it, ruling 4), and that closing discards it.
 */
describe('side chat model', () => {
  it('opens on the conversation, empty and in its own window by default', () => {
    const open = openSideChat(INITIAL_SIDE_CHAT, 's1');
    expect(open).toEqual({ open: true, form: 'window', sessionId: 's1', entries: [] });
    // Already open on it: the very same state.
    expect(openSideChat(open, 's1')).toBe(open);
  });

  it('closing discards what was asked; the form is remembered', () => {
    let state = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', 'why?');
    state = setSideChatForm(state, 'dock');
    state = settleSideQuestion(state, 'q1', { kind: 'answer', text: 'because' });
    const closed = closeSideChat(state);
    expect(closed).toEqual({ open: false, form: 'dock', sessionId: null, entries: [] });
    expect(openSideChat(closed, 's1')).toEqual({
      open: true,
      form: 'dock',
      sessionId: 's1',
      entries: [],
    });
  });

  it('toggles (decision 209 §3): on this conversation closes, on another moves, closed opens', () => {
    const open = toggleSideChat(INITIAL_SIDE_CHAT, 's1');
    expect(open.open).toBe(true);
    expect(toggleSideChat(open, 's1').open).toBe(false);
    const asked = addSideQuestion(open, 's1', 'q1', 'why?');
    const moved = toggleSideChat(asked, 's2');
    expect(moved).toMatchObject({ open: true, sessionId: 's2', entries: [] });
    // No conversation open: only closing is possible.
    expect(toggleSideChat(asked, null).open).toBe(false);
    expect(toggleSideChat(INITIAL_SIDE_CHAT, null)).toBe(INITIAL_SIDE_CHAT);
  });

  it('belongs to one conversation and stays on it until that one is gone (ruling 4)', () => {
    const asked = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', 'why?');
    const other = openSideChat(asked, 's2');
    expect(other.sessionId).toBe('s2');
    expect(other.entries).toEqual([]);
    // Another conversation on screen changes nothing; its own leaving the list closes it.
    expect(pruneSideChat(asked, ['s1', 's2'])).toBe(asked);
    expect(pruneSideChat(asked, ['s2']).open).toBe(false);
    expect(pruneSideChat(INITIAL_SIDE_CHAT, [])).toBe(INITIAL_SIDE_CHAT);
  });

  it('a question waits, then settles; one at a time', () => {
    const asked = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', '  why?  ');
    expect(asked.entries).toEqual([{ id: 'q1', question: 'why?', status: 'pending' }]);
    expect(sideChatBusy(asked)).toBe(true);
    expect(pendingSideQuestionIds(asked)).toEqual(['q1']);
    const answered = settleSideQuestion(asked, 'q1', { kind: 'answer', text: 'because' });
    expect(answered.entries[0]).toMatchObject({ status: 'answered', answer: 'because' });
    expect(sideChatBusy(answered)).toBe(false);
    expect(settleSideQuestion(asked, 'q1', { kind: 'answer', text: null }).entries[0]?.status).toBe(
      'no-answer'
    );
    expect(
      settleSideQuestion(asked, 'q1', { kind: 'failed', errorKey: 'K' }).entries[0]
    ).toMatchObject({ status: 'failed', errorKey: 'K' });
  });

  it('an answer to a discarded question arrives to nothing', () => {
    const asked = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', 'why?');
    const closed = closeSideChat(asked);
    expect(settleSideQuestion(closed, 'q1', { kind: 'answer', text: 'late' })).toBe(closed);
    const answered = settleSideQuestion(asked, 'q1', { kind: 'answer', text: 'a' });
    expect(settleSideQuestion(answered, 'q1', { kind: 'answer', text: 'b' })).toBe(answered);
  });

  it('a follow-up carries the earlier answered questions only', () => {
    let state = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', 'one?');
    state = settleSideQuestion(state, 'q1', { kind: 'answer', text: 'A' });
    state = addSideQuestion(state, 's1', 'q2', 'two?');
    state = settleSideQuestion(state, 'q2', { kind: 'failed', errorKey: 'K' });
    state = addSideQuestion(state, 's1', 'q3', 'three?');
    expect(sideQuestionHistory(state.entries, 'q3')).toEqual([{ question: 'one?', answer: 'A' }]);
    expect(sideQuestionHistory(state.entries, 'q1')).toEqual([]);
  });

  it('docks while there is room for it; otherwise lies over the chat', () => {
    // Decision 209 §4: the room is `fitShell`'s answer (panes squeezed first),
    // with this column as the slot — see shellFitModel.test.ts.
    const base = { open: true };
    expect(resolveSideChatPlacement({ ...base, form: 'window', dockFits: true })).toBe('window');
    expect(resolveSideChatPlacement({ ...base, form: 'window', dockFits: false })).toBe('window');
    expect(resolveSideChatPlacement({ ...base, form: 'dock', dockFits: true })).toBe('dock');
    expect(resolveSideChatPlacement({ ...base, form: 'dock', dockFits: false })).toBe('dock-over');
    expect(resolveSideChatPlacement({ open: false, form: 'dock', dockFits: true })).toBe('hidden');
    expect(SIDE_CHAT_DOCK_WIDTH + SIDE_CHAT_MIN_CHAT_WIDTH).toBe(860);
  });

  it('a docked side chat takes the session rail’s place', () => {
    const input = { userShown: true, sessionOpen: true, fits: true };
    expect(resolveSessionRailVisibility({ ...input, sideChatDocked: true })).toEqual({
      visible: false,
      hidden: 'side-chat',
    });
    expect(resolveSessionRailVisibility({ ...input, sideChatDocked: false }).visible).toBe(true);
    // The user's own choice still reads as theirs.
    expect(
      resolveSessionRailVisibility({ ...input, userShown: false, sideChatDocked: true }).hidden
    ).toBe('user');
  });
});
