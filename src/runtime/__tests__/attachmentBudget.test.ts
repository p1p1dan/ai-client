import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_READ_BYTES } from '../../shared/types/attachmentIo.ts';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TURN_STORED_BYTES,
  preparePrompt,
} from '../plugins/agent-loop/attachments.ts';
import { SESSION_MAX_BYTES } from '../plugins/session/codec.ts';

/**
 * capacity-01 — the server-side attachment budget.
 *
 * The renderer's own limits are not a defence: `attachments` crosses preload,
 * the chat IPC handler and the worker bridge without one byte check, and
 * whatever arrives is written verbatim into the session JSONL. Before this
 * budget existed, three maximum-size sends left the conversation permanently
 * read-only, which is the failure the cases below are about.
 */
describe('attachment byte budget', () => {
  /** A base64 payload of a given LENGTH (its decoded size is ~3/4 of that). */
  const base64OfLength = (length: number): string => 'A'.repeat(length);

  it('mirrors the main process read guard, so a file Main would refuse cannot arrive by another door', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(MAX_ATTACHMENT_READ_BYTES);
    expect(ATTACHMENT_TURN_STORED_BYTES).toBe(Math.floor(SESSION_MAX_BYTES / 4));
  });

  it('accepts an ordinary send unchanged', () => {
    const prepared = preparePrompt('look at this', [
      { kind: 'image', mediaType: 'image/png', data: base64OfLength(4096), name: 'shot.png' },
      { kind: 'text', mediaType: 'text/plain', data: 'hello', name: 'spec.md' },
    ]);
    expect(prepared.images).toHaveLength(1);
    expect(prepared.text).toContain('--- spec.md ---');
    expect(prepared.metadata).toHaveLength(2);
  });

  it('refuses one image whose decoded size is over the per-attachment ceiling', () => {
    // 8 MiB of base64 is ~6 MiB of picture: past the 5 MiB Main would read.
    const oversized = base64OfLength(8 * 1024 * 1024);
    expect(() =>
      preparePrompt('here', [
        { kind: 'image', mediaType: 'image/png', data: oversized, name: 'huge.png' },
      ])
    ).toThrowError(/attachment "huge.png" is \d+ bytes/);
  });

  it('refuses one text document over the per-attachment ceiling', () => {
    const oversized = 'x'.repeat(ATTACHMENT_MAX_BYTES + 1);
    expect(() =>
      preparePrompt('here', [
        { kind: 'text', mediaType: 'text/plain', data: oversized, name: 'dump.log' },
      ])
    ).toThrowError(/attachment "dump.log" is \d+ bytes/);
  });

  it('refuses a send whose attachments together would claim too much of the session file', () => {
    // Each one is legal on its own; what they add up to on disk is not.
    const half = base64OfLength(Math.floor(ATTACHMENT_TURN_STORED_BYTES * 0.6));
    expect(() =>
      preparePrompt('two photos', [
        { kind: 'image', mediaType: 'image/png', data: half, name: 'a.png' },
        { kind: 'image', mediaType: 'image/png', data: half, name: 'b.png' },
      ])
    ).toThrowError(/attachments would add \d+ bytes to the session file/);
  });

  it('still refuses an attachment kind it does not understand', () => {
    expect(() =>
      preparePrompt('here', [{ kind: 'video', mediaType: 'video/mp4', data: 'AAAA' } as never])
    ).toThrowError(/unsupported attachment kind: video/);
  });
});
