import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TURN_STORED_BYTES,
  preparePrompt,
} from '../plugins/agent-loop/attachments.ts';
import { SESSION_MAX_BYTES } from '../plugins/session/codec.ts';
import { JsonlSessionStore, SESSION_MAX_ENTRY_BYTES } from '../plugins/session/store.ts';
import { neverAsked } from './fixtures/approval.ts';

/**
 * DEV-33 — "fill the session file with image attachments until it will not
 * open again", reproduced inside the runtime package instead of through the
 * Electron composer, plus the two defects that reproduction found (D1/D24 and
 * D25) and T061 fixed.
 *
 * The checklist entry this stands in for expects two things: that 2~3 sends of
 * several images each push the session JSONL to 32 MiB, and that reopening the
 * conversation then fails with `io_limit`. Both are recorded here AS MEASURED,
 * and where the measurement disagrees with the expectation the case asserts the
 * behaviour the product actually has — see the comments on each assertion.
 *
 * The bytes travel the product's own path: `preparePrompt` is the gate a real
 * send passes through (agent-loop/index.ts:209), the message that reaches the
 * file has the shape pi's agent builds for `prompt(text, images)` (one text
 * block followed by the image blocks), and it is written with the store's
 * `appendMessage` — the same call agent-loop/index.ts:496 makes. Nothing here
 * hand-writes a JSONL row.
 */

let dir: string;
let ctx: Context;
let io: HostIoPlugin;
let exec: ExecPlugin;
const live: RuntimeHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-attachment-fill-'));
  const config = standaloneHost({ PATH: process.env.PATH });
  ctx = new Context();
  await ctx.plugin(ExecPlugin, config);
  const fiber = await ctx.plugin(HostIoPlugin, config);
  await fiber.await();
  exec = ctx.runtimeExec as ExecPlugin;
  io = ctx.runtimeHostIo as HostIoPlugin;
});

afterEach(async () => {
  for (const handle of live.splice(0)) await handle.dispose().catch(() => {});
  await exec.shutdown();
  await io.shutdown();
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Base64 of a given LENGTH. The picture behind it is ~3/4 of that, which is the
 * ratio both budgets are written in terms of.
 */
const base64OfLength = (length: number): string => 'A'.repeat(length);

/** The largest base64 payload whose decoded size still fits one attachment. */
const MAX_IMAGE_BASE64_CHARS = Math.floor((ATTACHMENT_MAX_BYTES * 4) / 3);

/**
 * Room left for the JSON envelope around the payloads.
 *
 * `preparePrompt` weighs the base64 strings alone; the session's per-entry net
 * weighs the row that carries them, envelope included. A send sized to exactly
 * the first ceiling therefore fails the second — see the last case.
 */
const ENVELOPE_SLACK = 4096;

/** A maximum-size send: one ~5 MiB photo plus whatever still fits beside it. */
function maximumSend(): Parameters<typeof preparePrompt>[1] {
  const second = ATTACHMENT_TURN_STORED_BYTES - ENVELOPE_SLACK - MAX_IMAGE_BASE64_CHARS;
  return [
    {
      kind: 'image',
      mediaType: 'image/png',
      data: base64OfLength(MAX_IMAGE_BASE64_CHARS),
      name: 'photo.png',
    },
    { kind: 'image', mediaType: 'image/png', data: base64OfLength(second), name: 'shot.png' },
  ];
}

/** The user message pi builds for `prompt(text, images)`, which is what lands. */
function userMessage(text: string, attachments: Parameters<typeof preparePrompt>[1]): AgentMessage {
  const prepared = preparePrompt(text, attachments);
  return {
    role: 'user',
    content: [{ type: 'text', text: prepared.text }, ...prepared.images],
    timestamp: Date.now(),
  } as AgentMessage;
}

const shortMessage = (text: string): AgentMessage => ({
  role: 'user',
  content: text,
  timestamp: Date.now(),
});

const errorCode = (error: unknown): string =>
  (error as { code?: string } | undefined)?.code ?? String(error);

describe('DEV-33 — a session file filled with image attachments', () => {
  it('stops at session_size_limit just under the budget, stays writable, and still reopens', async () => {
    const file = join(dir, 'session.jsonl');
    const store = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'create' });

    // Send maximum-size messages until the product refuses one, rather than
    // assuming how many it takes: the count IS the measurement DEV-33 wants.
    let accepted = 0;
    let refusal: unknown;
    let bytesAfterThird = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await store.appendMessage(userMessage(`screenshots ${attempt}`, maximumSend()));
        accepted += 1;
        if (accepted === 3) bytesAfterThird = (await stat(file)).size;
      } catch (error) {
        refusal = error;
        break;
      }
    }
    const filled = (await stat(file)).size;
    console.info(
      `[DEV-33] accepted sends=${accepted} file bytes=${filled} ` +
        `(${(filled / 1024 / 1024).toFixed(2)} MiB of ${SESSION_MAX_BYTES / 1024 / 1024} MiB), ` +
        `bytes after 3 sends=${bytesAfterThird}, refusal=${errorCode(refusal)}`
    );

    // The refusal is the aggregate budget, and it names itself.
    expect(errorCode(refusal)).toBe('session_size_limit');

    // DIVERGENCE FROM THE CHECKLIST (1/2): the checklist says 2~3 sends reach
    // 32 MiB. Since T046 capped one send at 8 MiB of stored bytes, three of
    // them cannot: the file is still around three quarters of the budget.
    expect(accepted).toBeGreaterThan(3);
    expect(bytesAfterThird).toBeLessThan(SESSION_MAX_BYTES);

    // The file never crosses the budget, because the write that would is the
    // one refused. "Approaching" is as far as it gets.
    expect(filled).toBeLessThanOrEqual(SESSION_MAX_BYTES);
    expect(filled).toBeGreaterThan(SESSION_MAX_BYTES * 0.9);

    // D1/D24, THE FIX. Refusing that one send must leave the conversation
    // usable: there are still a few KiB of headroom and a one-line reply fits
    // in them. Before T061 the aggregate budget was checked only INSIDE the
    // write queue, and `enqueue` made the rejected promise the queue's new
    // tail — so every later write on this instance failed with the same error,
    // a plain text message included, and the real app showed a conversation
    // that swallowed everything typed into it until it was restarted.
    await expect(store.appendMessage(shortMessage('and a short one'))).resolves.toBeUndefined();
    expect((await stat(file)).size).toBeGreaterThan(filled);
    // Still refuses what genuinely does not fit, and still refuses it the same
    // way the second time — the fix is "not poisoned", not "budget dropped".
    await expect(
      store.appendMessage(userMessage('one more batch', maximumSend()))
    ).rejects.toMatchObject({ code: 'session_size_limit' });
    await expect(store.appendMessage(shortMessage('still fine'))).resolves.toBeUndefined();
    // A refusal is not a write failure: it left the file intact, so nothing is
    // latched for the host to report at close (session-06 keeps that latch for
    // a full disk, which still poisons the queue).
    expect(store.writeFailure).toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();
    await store.close().catch(() => {});

    // DIVERGENCE FROM THE CHECKLIST (2/2): reopening does NOT throw `io_limit`.
    // It cannot — `open` reads with `maxBytes: SESSION_MAX_BYTES` and the store
    // refused every write that would have pushed the file past that same
    // number, so a file this store wrote is always inside its own read window.
    const reopened = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'resume' });
    try {
      // The four picture sends plus the two short replies the fix let through.
      expect(reopened.snapshot().entries.length).toBe(accepted + 2);
    } finally {
      await reopened.close();
    }

    // `io_limit` is reachable, but only for a file that grew past the budget by
    // some route the store does not police — a pre-budget build, an external
    // editor, a hand-merged file. Simulated here by appending filler behind the
    // store's back.
    const grown = (await stat(file)).size;
    await appendFile(file, Buffer.alloc(SESSION_MAX_BYTES - grown + 1, 0x41));
    expect((await stat(file)).size).toBeGreaterThan(SESSION_MAX_BYTES);
    // Resolved to a string on both branches: a store instance is a cordis
    // proxy, and letting `expect().rejects` print one on failure crashes the
    // reporter instead of showing what happened.
    const reopen = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'resume' }).then(
      (opened) => {
        void opened.close().catch(() => {});
        return 'opened';
      },
      (error: unknown) => errorCode(error)
    );
    expect(reopen).toBe('io_limit');
  }, 120_000);

  it('refuses a send sized to the attachment ceiling with the per-entry code, not the attachment one', async () => {
    // capacity-01 sets the per-send attachment share and capacity-04 sets the
    // per-row net to the SAME number (a quarter of the budget), but they weigh
    // different things: the first weighs the base64, the second weighs the row
    // around it. A send at exactly the first ceiling is accepted by the gate
    // that names the attachment and refused by the one that does not.
    expect(ATTACHMENT_TURN_STORED_BYTES).toBe(SESSION_MAX_ENTRY_BYTES);
    const file = join(dir, 'exact.jsonl');
    const store = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'create' });
    try {
      const exact = [
        {
          kind: 'image' as const,
          mediaType: 'image/png',
          data: base64OfLength(MAX_IMAGE_BASE64_CHARS),
          name: 'photo.png',
        },
        {
          kind: 'image' as const,
          mediaType: 'image/png',
          data: base64OfLength(ATTACHMENT_TURN_STORED_BYTES - MAX_IMAGE_BASE64_CHARS),
          name: 'shot.png',
        },
      ];
      // The attachment gate lets it through: the payloads total exactly the cap.
      const message = userMessage('right on the line', exact);
      await expect(store.appendMessage(message)).rejects.toMatchObject({
        code: 'session_entry_size_limit',
      });
      // Same fix as above, on the other ceiling: the per-row net was already
      // pre-flighted outside the queue, but its in-queue copy could still be
      // reached by a payload the pre-flight under-measured.
      await expect(store.appendMessage(shortMessage('after the refusal'))).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  }, 60_000);

  it('D1 — answers an over-budget write immediately, without putting it in the queue', async () => {
    // The other half of the fix, and capacity-04's stated reason for keeping a
    // ceiling OUTSIDE the queue: a write that cannot succeed is refused now,
    // on the spot, rather than being parked behind whatever is being written
    // and refused whenever that finishes. The in-queue copy stays as the exact
    // check — this only keeps a doomed write from ever reaching it.
    const file = join(dir, 'preflight.jsonl');
    const store = await JsonlSessionStore.open(io, {
      file,
      cwd: dir,
      mode: 'create',
      maxBytes: 8_192,
    });
    // Most of the budget spent up front, so the refusal below is about what is
    // LEFT in the file rather than about the size of one row.
    await store.appendMessage(shortMessage('z'.repeat(5_000)));
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realAppend = io.appendFile.bind(io);
    const append = vi
      .spyOn(io, 'appendFile')
      .mockImplementation(async (...args: Parameters<typeof realAppend>) => {
        await stalled;
        return realAppend(...args);
      });
    try {
      const slow = store.appendMessage(shortMessage('first, and slow to land'));
      // Sized to trip the AGGREGATE budget only: 3 KiB is far under the
      // per-row net (which is the whole 8 KiB budget here), but there is no
      // longer 3 KiB of file left. Before T061 the pre-flight knew about the
      // per-row net alone, so this one reached the queue.
      const doomed = store.appendMessage(shortMessage('y'.repeat(3_000)));
      const outcome = await Promise.race([
        doomed.then(
          () => 'accepted',
          (error: unknown) => errorCode(error)
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('still queued behind the slow write'), 50);
        }),
      ]);
      expect(outcome).toBe('session_size_limit');
      // Never offered to the file: the pre-flight settled it.
      expect(append).toHaveBeenCalledTimes(1);
      release();
      await expect(slow).resolves.toBeUndefined();
    } finally {
      release();
      append.mockRestore();
      await store.close();
    }
  }, 60_000);

  it('D25 — keeps the attachment file name across a close and reopen', async () => {
    const file = join(dir, 'named.jsonl');
    const store = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'create' });
    await store.appendMessage(
      userMessage('look at these', [
        { kind: 'image', mediaType: 'image/png', data: base64OfLength(64), name: 'big-5mib.png' },
        { kind: 'image', mediaType: 'image/jpeg', data: base64OfLength(32), name: 'holiday.jpg' },
      ])
    );
    // Live: the chip labels come off `preparePrompt`'s metadata, which has
    // always carried the names. That half was never broken.
    expect(
      preparePrompt('x', [
        { kind: 'image', mediaType: 'image/png', data: base64OfLength(8), name: 'big-5mib.png' },
      ]).metadata
    ).toEqual([{ kind: 'image', mediaType: 'image/png', name: 'big-5mib.png' }]);
    await store.close();

    // Reopened: the names used to be gone, because the stored image block held
    // only `{type, data, mimeType}` and history fell back to the media type.
    const reopened = await JsonlSessionStore.open(io, { file, cwd: dir, mode: 'resume' });
    try {
      const [message] = reopened.history();
      expect(message?.attachments).toEqual([
        { kind: 'image', mediaType: 'image/png', name: 'big-5mib.png' },
        { kind: 'image', mediaType: 'image/jpeg', name: 'holiday.jpg' },
      ]);
    } finally {
      await reopened.close();
    }
  }, 60_000);

  it('D24 — reports the refusal to the renderer and takes the next send', async () => {
    // The other half of D24: a refusal that nobody can see is worse than the
    // refusal. Driven through the whole loop rather than the store, because the
    // question is whether `appendMessage`'s rejection survives pi's listener
    // dispatch and comes back out as a `session.failed` event — the channel the
    // renderer already turns into its error banner.
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', contextWindow: 32_000, maxTokens: 4096 }],
    });
    const file = join(dir, 'tight.jsonl');
    const handle = await createRuntime({
      providers: [faux.provider],
      env: {},
      traceDir: null,
      tools: { cwd: dir },
      // Room for the header, the bookkeeping entries and one short exchange —
      // not for the prompt the first run sends.
      session: { file, cwd: dir, mode: 'create', maxBytes: 8_192 },
      permissions: { approve: neverAsked },
    });
    live.push(handle);
    const events: RuntimeEventDraft[] = [];
    handle.events.subscribe((event) => events.push(event));
    // ONE response for TWO sends: the refused one must never reach the
    // provider, so the reply below belongs to the send that follows it.
    faux.setResponses([fauxAssistantMessage('still here')]);

    const refused = await handle.run({
      prompt: 'x'.repeat(16_000),
      systemPrompt: 'probe',
      logicalSessionId: 'logical',
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('session exceeds the configured size budget');
    // Refused before the request, not after it: nothing was spent.
    expect(refused.text).toBe('');
    // The visible half: one failure event carrying the sentence, on the
    // existing terminal-event channel. No new path was added for this.
    expect(events.filter((event) => event.type === 'session.failed')).toMatchObject([
      { sessionId: 'logical', payload: { error: refused.error?.message } },
    ]);

    // And the conversation is still alive: the next send reaches the model and
    // is written. This is the assertion the real machine could not make — after
    // one refusal the app accepted the text, cleared the composer and did
    // nothing at all, for as long as the worker lived.
    events.length = 0;
    const next = await handle.run({
      prompt: 'hi',
      systemPrompt: 'probe',
      logicalSessionId: 'logical',
    });
    expect(next.success).toBe(true);
    expect(next.text).toContain('still here');
    expect(events.some((event) => event.type === 'session.failed')).toBe(false);
    // The transcript the model will be given next time: the refused prompt is
    // simply not in it (the run that failed left only the empty assistant turn
    // `snapshot()` already filters out), and the send after it is.
    expect(
      handle.session?.snapshot().messages.map((message) => (message as { role: string }).role)
    ).toEqual(['user', 'assistant']);
  }, 60_000);
});
