import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateTranscript, type TranscriptRoots } from '../transcriptLocation';

// Route B S-6 feedback 7: the Context panel names where a chat's record lives.
let base = '';
let roots: TranscriptRoots;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'transcript-location-'));
  roots = { dshHome: path.join(base, 'dsh-home'), claudeSdkConfigDir: path.join(base, 'claude') };
  mkdirSync(path.join(roots.dshHome, 'aiclient-sessions'), { recursive: true });
  mkdirSync(path.join(roots.claudeSdkConfigDir, 'aiclient-sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const CC = '1b6035fe-6545-48d7-9950-5ab4c7f0b24a';

describe('locateTranscript', () => {
  it("finds an Agent SDK chat's CLI transcript by the id its stub is named after", () => {
    const stub = path.join(roots.claudeSdkConfigDir, 'aiclient-sessions', `${CC}.ccsdk.json`);
    writeFileSync(stub, '{}');
    const project = path.join(roots.claudeSdkConfigDir, 'projects', 'E--code-proj');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, `${CC}.jsonl`), '');
    expect(locateTranscript(stub, roots)).toEqual({
      path: path.join(project, `${CC}.jsonl`),
      kind: 'file',
      engine: 'claude-sdk',
    });
  });

  it('answers null for an Agent SDK chat whose transcript is not written yet', () => {
    const stub = path.join(roots.claudeSdkConfigDir, 'aiclient-sessions', `${CC}.ccsdk.json`);
    writeFileSync(stub, '{}');
    expect(locateTranscript(stub, roots)).toBeNull();
  });

  it("finds a DSH chat's record through the dshSessionId its stub names", () => {
    const stub = path.join(roots.dshHome, 'aiclient-sessions', 'aiclient-session-1-abc.dsh.json');
    writeFileSync(stub, JSON.stringify({ dshSessionId: 'aiclient-session-1-abc' }));
    const dir = path.join(roots.dshHome, 'sessions', '--F-tmp--', 'aiclient-session-1-abc');
    mkdirSync(dir, { recursive: true });
    expect(locateTranscript(stub, roots)).toEqual({ path: dir, kind: 'directory', engine: 'dsh' });
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '');
    expect(locateTranscript(stub, roots)).toEqual({
      path: path.join(dir, 'session.v4.jsonl.zstd'),
      kind: 'file',
      engine: 'dsh',
    });
  });

  it('reads no stub outside the two stub directories, and no id that could climb out', () => {
    const outside = path.join(base, 'elsewhere', `${CC}.ccsdk.json`);
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, '{}');
    expect(locateTranscript(outside, roots)).toBeNull();
    const stub = path.join(roots.dshHome, 'aiclient-sessions', 'x.dsh.json');
    writeFileSync(stub, JSON.stringify({ dshSessionId: '../../secrets' }));
    expect(locateTranscript(stub, roots)).toBeNull();
    expect(locateTranscript('relative/x.dsh.json', roots)).toBeNull();
    expect(
      locateTranscript(path.join(roots.dshHome, 'aiclient-sessions', 'x.txt'), roots)
    ).toBeNull();
  });
});
