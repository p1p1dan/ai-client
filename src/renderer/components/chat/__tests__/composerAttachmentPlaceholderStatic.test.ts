import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerPlaceholder } from '../middleColumnLayout';
import { stripComments } from './stripComments';

/**
 * P1-14 GUI recheck finding 1 (2026-10-18): 「正在发送 1 个附件…」 never showed.
 * The drafts leave the box at the send's commit point (T-19), and the
 * placeholder counted the drafts, which by then were none. While this chat's
 * send is in flight the placeholder counts the send's own snapshot instead.
 */
describe('the attachments placeholder while sending', () => {
  const SOURCE = stripComments(
    readFileSync(path.join(__dirname, '..', 'ChatComposer.tsx'), 'utf8'),
    'ChatComposer.tsx'
  );

  it('reads the in-flight send snapshot, not the emptied draft list, while this chat sends', () => {
    expect(SOURCE).toContain(
      'attachmentCount: sendingHere ? inFlightAttachmentCount : attachments.drafts.length'
    );
    expect(SOURCE).toMatch(
      /const inFlightAttachmentCount = useTurnSendStatusStore\(\(state\) =>\s+state\.status && state\.status\.sessionId === activeSessionId \? state\.status\.attachmentCount : 0/
    );
    // Declared after the session it reads, or the first render throws.
    expect(SOURCE.indexOf('const activeSessionId =')).toBeLessThan(
      SOURCE.indexOf('const inFlightAttachmentCount =')
    );
  });

  it('words the count it is given', () => {
    const base = {
      mode: 'session' as const,
      canSend: true,
      busy: false,
      sending: true,
      hasSession: true,
      hasWorkspace: true,
      hasCwd: true,
    };
    expect(composerPlaceholder({ ...base, attachmentCount: 1 })).toBe('Sending 1 attachment…');
    expect(composerPlaceholder({ ...base, attachmentCount: 2 })).toBe('Sending 2 attachments…');
    expect(composerPlaceholder({ ...base, attachmentCount: 0 })).toBe('Sending…');
  });
});
