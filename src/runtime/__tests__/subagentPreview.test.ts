/**
 * P5-2-3 gate — SA20's runtime half: `browser_preview` end to end inside the
 * worker, from the tool call to the host's answer.
 *
 * What these pin down is the seam the contract names: "工作区 HTML 预览、编辑
 * 后自动刷新、前台归属、不可用明确错误". The window itself is Electron's and is
 * covered on the Main side; everything up to the request leaving the runtime,
 * and everything after the answer comes back, is here.
 *
 * The case worth stating out loud is the last one. A preview that cannot be
 * shown has to reach the model as a FAILED tool call. If the host's refusal
 * resolved instead, the model would be told a page is on screen when nothing
 * is — and it would keep building on a preview nobody can see.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { browserPreviewTool } from '../plugins/tools/browserPreview.ts';
import { createPreviewPrompt } from '../worker/previewPrompt.ts';

/** The tools plugin's gate, stubbed: it is exercised by its own suite. */
const passthrough = async (_id: string, input: string) => `/work/${input}`;

function harness() {
  const events: RuntimeEventDraft[] = [];
  const prompt = createPreviewPrompt({
    sessionId: 'session-1',
    emit: (event) => events.push(event),
  });
  return { events, prompt, tool: browserPreviewTool(prompt.preview, passthrough) };
}

function requestedIds(events: readonly RuntimeEventDraft[]): string[] {
  return events
    .filter((event) => event.type === 'preview.requested')
    .map((event) => (event.payload as { previewId: string }).previewId);
}

describe('SA20 · browser_preview asks the host and waits for a real answer', () => {
  it('emits one request carrying the gated path, and resolves when the host says yes', async () => {
    const { events, prompt, tool } = harness();
    const call = tool.execute('call-1', { path: 'demo/index.html' }, undefined, () => undefined);

    // The request is out before the tool call settles: that is what lets Main
    // open a window while the turn is still parked on the answer.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: 'preview.requested',
      sessionId: 'session-1',
      payload: { path: '/work/demo/index.html', focus: false },
    });

    expect(prompt.respond({ previewId: requestedIds(events)[0], ok: true })).toBe(true);
    const result = await call;
    expect(JSON.stringify(result.content)).toContain('/work/demo/index.html');
    expect(result.details).toMatchObject({ path: '/work/demo/index.html', focus: false });
  });

  it('passes focus through only when the caller asked for it', async () => {
    const { events, prompt, tool } = harness();
    const call = tool.execute(
      'call-1',
      { path: 'page.html', focus: true },
      undefined,
      () => undefined
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect((events[0].payload as { focus: boolean }).focus).toBe(true);
    prompt.respond({ previewId: requestedIds(events)[0], ok: true });
    const result = await call;
    // Said in the result text too: the model asked to take the front, and the
    // user seeing their focus move should be something the transcript explains.
    expect(JSON.stringify(result.content)).toContain('front');
  });

  it('fails the tool call when the host cannot show it, with the host reason', async () => {
    const { events, prompt, tool } = harness();
    const call = tool.execute('call-1', { path: 'page.html' }, undefined, () => undefined);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    prompt.respond({
      previewId: requestedIds(events)[0],
      ok: false,
      error: 'this build has no preview surface',
    });
    await expect(call).rejects.toThrow('this build has no preview surface');
  });

  it('refuses a file type the preview window cannot render, without asking the host', async () => {
    // Markdown is the case this rule exists for: a Chromium window shows a
    // `.md` file as its own source, so accepting it would report success and
    // put a wall of `##` on screen.
    const { events, tool } = harness();
    await expect(
      tool.execute('call-1', { path: 'notes.md' }, undefined, () => undefined)
    ).rejects.toThrow(/browser_preview cannot show/);
    expect(events).toHaveLength(0);
  });

  it('gives each request its own id, so two previews cannot cross', async () => {
    const { events, prompt, tool } = harness();
    const first = tool.execute('call-1', { path: 'a.html' }, undefined, () => undefined);
    const second = tool.execute('call-2', { path: 'b.html' }, undefined, () => undefined);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const [firstId, secondId] = requestedIds(events);
    expect(firstId).not.toBe(secondId);

    prompt.respond({ previewId: secondId, ok: false, error: 'b failed' });
    await expect(second).rejects.toThrow('b failed');
    prompt.respond({ previewId: firstId, ok: true });
    await expect(first).resolves.toBeDefined();
  });

  it('reports an answer nobody is waiting for rather than inventing one', () => {
    const { prompt } = harness();
    expect(prompt.respond({ previewId: 'never-asked', ok: true })).toBe(false);
  });

  it('settles a parked preview when the turn is aborted', async () => {
    const { events, tool } = harness();
    const controller = new AbortController();
    const call = tool.execute('call-1', { path: 'page.html' }, controller.signal, () => undefined);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort();
    // A failure, not a quiet success: nothing was put on screen.
    await expect(call).rejects.toThrow(/stopped/);
  });

  it('settles everything parked when the session closes', async () => {
    const { events, prompt, tool } = harness();
    const call = tool.execute('call-1', { path: 'page.html' }, undefined, () => undefined);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    prompt.drain('session_closed');
    await expect(call).rejects.toThrow(/session closed/);
    // Drained means gone: a late answer must not find it again.
    expect(prompt.respond({ previewId: requestedIds(events)[0], ok: true })).toBe(false);
  });

  it('does not register a preview request for an already-aborted call', async () => {
    const { events, tool } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute('call-1', { path: 'page.html' }, controller.signal, () => undefined)
    ).rejects.toThrow(/stopped/);
    // One event was emitted (the request), but nothing stayed parked.
    expect(events).toHaveLength(1);
  });
});
