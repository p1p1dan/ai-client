import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const composer = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
);
const workspace = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatWorkspace.tsx'), 'utf8'),
  'ChatWorkspace.tsx'
);
const timeline = stripComments(
  readFileSync(path.join(__dirname, '..', 'MessageTimeline.tsx'), 'utf8'),
  'MessageTimeline.tsx'
);
const sessionsStore = stripComments(
  readFileSync(path.join(__dirname, '..', '..', '..', 'stores', 'chatSessions.ts'), 'utf8'),
  'chatSessions.ts'
);

describe('T24/T26 send experience wiring', () => {
  it('publishes an attempt-identified pending user message before the first Host await', () => {
    const sendStart = composer.lastIndexOf('onSendStart?.(origin)');
    const publish = composer.indexOf('usePendingUserMessagesStore.getState().publish({');
    const ensureHost = composer.indexOf('await window.electronAPI.chat.ensureHost()', publish);

    expect(sendStart).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(sendStart);
    expect(ensureHost).toBeGreaterThan(publish);
    expect(composer).toMatch(/const attemptId = `\$\{sessionId\}:\$\{sendOwner\}`/);
    // Indentation-agnostic: the fact under guard is that the SAME attemptId
    // rides in the send payload next to the text, not how deeply the payload
    // happens to be nested (it moved a level when the dispatch grew a
    // `.catch` for WorkerManager refusals).
    expect(composer).toMatch(/attemptId,\n\s+text: trimmed/);
    expect(composer).toContain("outcome === 'rejected' && pendingAttemptId");
  });

  it('pairs a pending attempt with the exact authoritative wire message id', () => {
    expect(sessionsStore).toContain("event.type === 'message.started'");
    expect(sessionsStore).toContain("event.payload.role === 'user'");
    expect(sessionsStore).toContain(
      '.acknowledgeAttempt(event.sessionId, event.payload.attemptId, event.payload.messageId)'
    );
    expect(sessionsStore).toContain('message.id === pending.authoritativeMessageId');
    expect(timeline).toContain('pendingUserToChatMessage');
    expect(timeline).toContain('isPendingUserMessage(message)');
  });

  it('turns direct, retry and explicit enqueue into a jump without scrolling on passive release', () => {
    expect(composer).toContain("onSendStart?.('direct')");
    expect(workspace).toContain("if (origin !== 'release')");
    expect(workspace).toContain('setSendJumpRequest((request) => request + 1)');
    expect(workspace).toContain('jumpToBottomRequest={sendJumpRequest}');
    expect(timeline).toContain('if (jumpToBottomRequest <= 0) return');
    expect(timeline).toContain('jumpToBottom();');
  });
});
