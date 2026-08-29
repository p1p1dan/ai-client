import { describe, expect, it } from 'vitest';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import { buildPrompt, PiAgentRuntime } from '../piRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';
import {
  type CapturedEvent,
  createPiSdkStub,
  type PiSdkStubOptions,
} from './fixtures/piSdkStub.ts';

const GATED: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

function makeHarness(options: PiSdkStubOptions = {}) {
  const events: CapturedEvent[] = [];
  const stub = createPiSdkStub(options);
  const registry = new SessionRegistry();
  const runtime = new PiAgentRuntime({
    registry,
    emit: (event) => events.push(event as CapturedEvent),
    log: () => undefined,
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => GATED,
  });
  return { events, registry, runtime, stub };
}

describe('PiAgentRuntime model selection', () => {
  it('applies the create-time provider/model choice before the first prompt', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model: 'glm/glm-5' });
    await h.runtime.send({ sessionId: 's1', text: 'hello' });

    expect(h.stub.sessionFor('/repo')?.model).toEqual({
      provider: 'glm',
      id: 'glm-5',
      name: 'GLM 5',
    });
    expect(h.stub.sessionFor('/repo')?.prompts.map((p) => p.text)).toEqual(['hello']);
    expect(h.registry.get('s1')?.model).toBe('glm/glm-5');
  });

  it('lets a send-time override win and persist as the session selection', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model: 'glm/glm-5' });
    await h.runtime.send({ sessionId: 's1', text: 'hello', model: 'dan/deepseek-v4' });

    expect(h.stub.sessionFor('/repo')?.model).toEqual({
      provider: 'dan',
      id: 'deepseek-v4',
      name: 'DeepSeek V4',
    });
    expect(h.registry.get('s1')?.model).toBe('dan/deepseek-v4');
  });

  it('fails visibly and never prompts for malformed or unknown model ids', async () => {
    for (const model of ['glm-only', 'glm/missing']) {
      const h = makeHarness();
      h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model });
      await h.runtime.send({ sessionId: 's1', text: 'hello' });

      expect(h.stub.sessionFor('/repo')?.prompts ?? []).toEqual([]);
      expect(h.events.some((event) => event.type === 'session.failed')).toBe(true);
    }
  });
});

describe('PiAgentRuntime effort', () => {
  it('applies a session-default effort and a per-send override', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', effort: 'medium' });
    await h.runtime.send({ sessionId: 's1', text: 'one' });
    await h.runtime.send({ sessionId: 's1', text: 'two', effort: 'xhigh' });

    // Our five effort words are a subset of pi's ThinkingLevel, so the mapping
    // is the identity — the point of the test is that the call HAPPENS.
    expect(h.stub.sessionFor('/repo')?.thinkingLevels).toEqual(['medium', 'xhigh']);
    expect(h.registry.get('s1')?.effort).toBe('xhigh');
  });

  it('never silently ignores an effort the SDK build cannot apply', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo' });
    // An SDK without setThinkingLevel: the request must fail loudly rather than
    // report a reasoning level that was never set.
    await h.runtime.send({ sessionId: 's1', text: 'one' });
    const session = h.stub.sessionFor('/repo');
    if (!session) throw new Error('no session');
    session.setThinkingLevel = undefined;

    await h.runtime.send({ sessionId: 's1', text: 'two', effort: 'high' });
    const failure = h.events.filter((event) => event.type === 'session.failed').at(-1);
    expect(String(failure?.payload?.error)).toContain('setThinkingLevel');
  });

  it('leaves the thinking level alone when no effort was asked for', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo' });
    await h.runtime.send({ sessionId: 's1', text: 'one' });
    expect(h.stub.sessionFor('/repo')?.thinkingLevels).toEqual([]);
  });
});

describe('PiAgentRuntime attachments', () => {
  it('sends images through pi’s only attachment slot', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo' });
    await h.runtime.send({
      sessionId: 's1',
      text: 'what is this',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }],
    });

    expect(h.stub.sessionFor('/repo')?.prompts).toEqual([
      {
        text: 'what is this',
        options: { images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      },
    ]);
  });

  it('accepts an attachment-only send', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo' });
    await h.runtime.send({
      sessionId: 's1',
      text: '',
      attachments: [{ kind: 'image', mediaType: 'image/jpeg', data: 'BBBB' }],
    });

    const prompt = h.stub.sessionFor('/repo')?.prompts.at(0);
    expect(prompt?.text).toBe('');
    expect(prompt?.options?.images).toHaveLength(1);
  });
});

describe('buildPrompt', () => {
  it('passes text through untouched when there is nothing attached', () => {
    expect(buildPrompt('hello', undefined)).toEqual({ text: 'hello' });
    expect(buildPrompt('hello', [])).toEqual({ text: 'hello' });
  });

  /**
   * pi has no document block, so a text attachment goes into the prompt as a
   * labelled section. The failure this replaces was the third option: accept it
   * on the wire and send a message without it.
   */
  it('appends text attachments to the prompt rather than dropping them', () => {
    const built = buildPrompt('review this', [
      { kind: 'text', mediaType: 'text/plain', data: 'line one', name: 'notes.txt' },
    ]);
    expect(built.text).toBe('review this\n\n--- notes.txt ---\nline one');
    expect(built.options).toBeUndefined();
  });

  it('carries images and text attachments together', () => {
    const built = buildPrompt('both', [
      { kind: 'image', mediaType: 'image/png', data: 'IMG' },
      { kind: 'text', mediaType: 'text/plain', data: 'TXT' },
    ]);
    expect(built.text).toBe('both\n\n--- attachment ---\nTXT');
    expect(built.options?.images).toEqual([{ type: 'image', data: 'IMG', mimeType: 'image/png' }]);
  });

  it('refuses an attachment kind it has no mapping for', () => {
    expect(() =>
      buildPrompt('x', [
        { kind: 'video', mediaType: 'video/mp4', data: 'V' } as unknown as {
          kind: 'image';
          mediaType: string;
          data: string;
        },
      ])
    ).toThrow(/Unsupported attachment kind/);
  });
});
