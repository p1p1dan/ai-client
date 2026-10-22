import { describe, expect, it } from 'vitest';
import { resolveSessionRailVisibility } from '../sessionRail/sessionRailModel';
import {
  addSideQuestion,
  clampSideChatFloatOffset,
  closeSideChat,
  followActiveSession,
  INITIAL_SIDE_CHAT,
  openSideChat,
  pendingSideQuestionIds,
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
 * Layout 5f (ui-cohesion ruling L6): the side chat's rules — open / float /
 * dock / close, which conversation it reads, and that closing discards it.
 */
describe('side chat model', () => {
  it('opens on the conversation, empty and floating by default', () => {
    const open = openSideChat(INITIAL_SIDE_CHAT, 's1');
    expect(open).toEqual({ open: true, form: 'float', sessionId: 's1', entries: [] });
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

  it('toggles: open closes, closed opens on the conversation, nothing without one', () => {
    const open = toggleSideChat(INITIAL_SIDE_CHAT, 's1');
    expect(open.open).toBe(true);
    expect(toggleSideChat(open, 's1').open).toBe(false);
    expect(toggleSideChat(INITIAL_SIDE_CHAT, null)).toBe(INITIAL_SIDE_CHAT);
  });

  it('belongs to one conversation: another one starts a fresh side chat', () => {
    const asked = addSideQuestion(INITIAL_SIDE_CHAT, 's1', 'q1', 'why?');
    const other = openSideChat(asked, 's2');
    expect(other.sessionId).toBe('s2');
    expect(other.entries).toEqual([]);
    // Switching the open conversation discards it.
    expect(followActiveSession(asked, 's2').open).toBe(false);
    expect(followActiveSession(asked, 's1')).toBe(asked);
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

  it('docks only while the chat keeps its room; otherwise floats', () => {
    const base = { open: true, sessionOpen: true };
    const roomy = SIDE_CHAT_DOCK_WIDTH + SIDE_CHAT_MIN_CHAT_WIDTH;
    expect(resolveSideChatPlacement({ ...base, form: 'float', chatWidth: 2000 })).toBe('float');
    expect(resolveSideChatPlacement({ ...base, form: 'dock', chatWidth: roomy })).toBe('dock');
    expect(resolveSideChatPlacement({ ...base, form: 'dock', chatWidth: roomy - 1 })).toBe('float');
    expect(resolveSideChatPlacement({ ...base, open: false, form: 'dock', chatWidth: 2000 })).toBe(
      'hidden'
    );
    expect(
      resolveSideChatPlacement({ ...base, sessionOpen: false, form: 'float', chatWidth: 2000 })
    ).toBe('hidden');
  });

  it('a docked side chat takes the session rail’s place', () => {
    const input = { userShown: true, sessionOpen: true, panesOpen: 0, chatWidth: 2000 };
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

describe('clampSideChatFloatOffset (user, 2026-10-22: the floating side chat can be dragged)', () => {
  const container = { width: 1000, height: 800 };
  const panel = { width: 380, height: 440 };

  it('lets the window move left and up inside the container', () => {
    expect(clampSideChatFloatOffset({ x: -200, y: -100 }, container, panel)).toEqual({
      x: -200,
      y: -100,
    });
  });

  it('never moves it past its resting corner (right / bottom)', () => {
    expect(clampSideChatFloatOffset({ x: 50, y: 30 }, container, panel)).toEqual({ x: 0, y: 0 });
  });

  it('stops at the far edges, keeping the margin', () => {
    // 1000 - 380 - 2*16 = 588; 800 - 440 - 2*16 = 328
    expect(clampSideChatFloatOffset({ x: -5000, y: -5000 }, container, panel)).toEqual({
      x: -588,
      y: -328,
    });
  });

  it('pins it to the corner when the container is too small to move in', () => {
    expect(
      clampSideChatFloatOffset({ x: -10, y: -10 }, { width: 300, height: 300 }, panel)
    ).toEqual({ x: 0, y: 0 });
  });
});
