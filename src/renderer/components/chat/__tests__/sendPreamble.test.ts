import { describe, expect, it } from 'vitest';
import { decideSendPreamble } from '../sendPreamble';

describe('decideSendPreamble', () => {
  it('sends direct when the Host registry entry is still bound', () => {
    expect(decideSendPreamble({ hostBound: true, runtimeIdentity: 'rt-1' })).toEqual({
      action: 'direct',
    });
  });

  it('resumes with the known runtime identity when not host-bound', () => {
    expect(decideSendPreamble({ hostBound: false, runtimeIdentity: 'rt-1' })).toEqual({
      action: 'resume',
      runtimeIdentity: 'rt-1',
    });
  });

  it('creates a fresh session when neither host-bound nor a runtime identity is known', () => {
    expect(decideSendPreamble({ hostBound: false, runtimeIdentity: null })).toEqual({
      action: 'create',
    });
    expect(decideSendPreamble({ hostBound: false, runtimeIdentity: undefined })).toEqual({
      action: 'create',
    });
  });

  it('prefers direct over resume even when a runtime identity is also known', () => {
    // hostBound must win: the registry entry is alive, so claudeRuntime already
    // passes `resume` internally — an explicit resumeSession call here would be
    // redundant at best and a session_busy error at worst.
    expect(decideSendPreamble({ hostBound: true, runtimeIdentity: 'rt-1' })).toEqual({
      action: 'direct',
    });
  });

  it('treats an empty-string runtime identity as absent', () => {
    expect(decideSendPreamble({ hostBound: false, runtimeIdentity: '' })).toEqual({
      action: 'create',
    });
  });
});
