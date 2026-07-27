import { describe, expect, it } from 'vitest';
import {
  classifyClipboardItem,
  type PastedItemDescriptor,
  planPaste,
} from '../clipboardAttachments';

const str = (type: string): PastedItemDescriptor => ({ kind: 'string', type });
const file = (type: string): PastedItemDescriptor => ({ kind: 'file', type });

describe('planPaste (T-18 P-01..P-07) — plain-text regression guard', () => {
  it('[P-01] leaves a plain-text paste completely native', () => {
    expect(planPaste([str('text/plain')], 'hello world')).toEqual({
      fileIndices: [],
      preventDefault: false,
    });
  });

  it('[P-02] tolerates an empty item list', () => {
    expect(planPaste([])).toEqual({ fileIndices: [], preventDefault: false });
  });

  it('[P-03] never turns rich text (html + plain) into an attachment', () => {
    expect(planPaste([str('text/html'), str('text/plain')], '<b>hi</b> as text')).toEqual({
      fileIndices: [],
      preventDefault: false,
    });
  });

  it('[P-04] intercepts a screenshot-tool paste (file item, no text flavour)', () => {
    expect(planPaste([file('image/png')])).toEqual({ fileIndices: [0], preventDefault: true });
  });

  it('[P-05] keeps native insert when a file arrives together with real text', () => {
    // Rich text from Word / a browser: the image is attached AND the text is
    // still inserted by the browser — nothing the user copied is dropped.
    expect(planPaste([str('text/plain'), file('image/png')], 'copied paragraph')).toEqual({
      fileIndices: [1],
      preventDefault: false,
    });
  });

  it('[P-06] intercepts a file paste whose text flavour is empty', () => {
    // Windows Explorer sometimes advertises a string item that yields ''.
    expect(planPaste([file(''), str('text/plain')], '')).toEqual({
      fileIndices: [0],
      preventDefault: true,
    });
  });

  it('[P-06b] Explorer copy with a real path string inserts the path natively', () => {
    expect(planPaste([file(''), str('text/plain')], 'D:\\Code\\notes.md')).toEqual({
      fileIndices: [0],
      preventDefault: false,
    });
  });

  it('[P-07] keeps clipboard order for a multi-image paste', () => {
    expect(planPaste([file('image/png'), file('image/jpeg')])).toEqual({
      fileIndices: [0, 1],
      preventDefault: true,
    });
  });

  it('[P-08] ignores non-text string items (e.g. custom flavours) for interception', () => {
    expect(planPaste([str('application/x-vscode-data')])).toEqual({
      fileIndices: [],
      preventDefault: false,
    });
  });
});

describe('classifyClipboardItem (T-18 CB-01..CB-03)', () => {
  it('[CB-01] plain-text string item is text', () => {
    expect(classifyClipboardItem(str('text/plain'))).toBe('text');
  });

  it('[CB-02] image file item is image', () => {
    expect(classifyClipboardItem(file('image/png'))).toBe('image');
  });

  it('[CB-03] file item without a MIME type is a generic file', () => {
    expect(classifyClipboardItem(file(''))).toBe('file');
  });

  it('[CB-04] non-text string item is ignored', () => {
    expect(classifyClipboardItem(str('application/json'))).toBe('ignore');
  });

  it('[CB-05] classification is case-insensitive on the MIME type', () => {
    expect(classifyClipboardItem(file('IMAGE/PNG'))).toBe('image');
    expect(classifyClipboardItem(str('TEXT/PLAIN'))).toBe('text');
  });
});
