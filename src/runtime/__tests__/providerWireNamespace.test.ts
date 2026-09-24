/**
 * T061 rework — what the app's own keys do at the boundary.
 *
 * `attachmentRider.ts` claimed a rider "never reaches the provider" because
 * every pi-ai adapter rebuilds the block it sends. That holds for nine of the
 * ten adapters; `pi-messages` sends the context verbatim, and this app lists
 * it as a user-selectable API. These cases drive a real request through a
 * recording fetch and read the body, because that is the only place the claim
 * is either true or false.
 */

import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAiclientKey, stripAiclientKeys } from '../../shared/aiclientKeys.ts';
import { attachmentNameRider } from '../../shared/attachmentRider.ts';
import { internalMessageMark } from '../../shared/internalMessage.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import type { CatalogApi, CatalogProvider, PiCatalog } from '../plugins/model-adapter/catalog.ts';
import { ModelAdapterPlugin } from '../plugins/model-adapter/index.ts';

let ctx: Context;
const sent: Array<{ url: string; body: unknown }> = [];

const recordingFetch: typeof fetch = async (input, init) => {
  sent.push({
    url: input instanceof Request ? input.url : String(input),
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
  });
  // 400 rather than a throw or a 5xx: the retriable ones get retried, and each
  // case here wants exactly one recorded request.
  return new Response('{"error":{"message":"recorded"}}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  sent.length = 0;
  ctx = new Context();
  await ctx.plugin(ExecPlugin, standaloneHost({}));
  const fiber = await ctx.plugin(HostIoPlugin, standaloneHost({}));
  await fiber.await();
});

afterEach(async () => {
  await ctx.fiber.dispose();
});

function catalog(api: CatalogApi): PiCatalog {
  const provider: CatalogProvider = {
    id: 'gateway',
    baseUrl: 'https://gateway.example/v1',
    headers: {},
    api,
    apiKey: 'sk-test',
    models: [
      {
        id: 'model-x',
        name: 'model-x',
        api,
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  };
  return { dir: null, providers: [provider], dropped: [] };
}

/** A history exactly as the session store holds it: riders on, both kinds. */
function riddenMessages() {
  return [
    Object.assign(
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'look at this' },
          {
            type: 'image' as const,
            data: 'AAAA',
            mimeType: 'image/png',
            ...attachmentNameRider('holiday.jpg'),
          },
        ],
        timestamp: 1,
      },
      internalMessageMark('subagent-report')
    ),
  ];
}

async function request(api: CatalogApi, messages: unknown[]): Promise<void> {
  await ctx.plugin(ModelAdapterPlugin, { catalog: catalog(api) });
  const resolved = ctx.runtimeModel.resolve({ provider: 'gateway', id: 'model-x' });
  try {
    await resolved.models
      .streamSimple(
        resolved.model,
        { messages } as Parameters<typeof resolved.models.streamSimple>[1],
        { fetch: recordingFetch, maxRetries: 0 }
      )
      .result();
  } catch {
    // The recorded 400 is the point; how the adapter reports it is not.
  }
}

describe('the app namespace at the provider boundary', () => {
  it('sends a pi-messages context with no app-owned key on it', async () => {
    const messages = riddenMessages();
    await request('pi-messages', messages);

    expect(sent).toHaveLength(1);
    const payload = sent[0].body as {
      context: { messages: Array<Record<string, unknown>> };
    };
    // pi-messages ships `{ model, context, options }` verbatim, so this is the
    // request body itself rather than a rebuilt one.
    const message = payload.context.messages[0];
    expect(message.aiclientInternal).toBeUndefined();
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(JSON.stringify(payload)).not.toContain('aiclient');
    expect(JSON.stringify(payload)).not.toContain('holiday.jpg');
  });

  it('leaves the caller’s own history untouched, so the session file keeps the rider', async () => {
    const messages = riddenMessages();
    await request('pi-messages', messages);

    const message = messages[0] as Record<string, unknown>;
    expect(message.aiclientInternal).toBe('subagent-report');
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[1].aiclientName).toBe('holiday.jpg');
  });

  it('changes nothing about a request that carries no rider', async () => {
    await request('pi-messages', [{ role: 'user', content: 'plain', timestamp: 1 }]);

    const payload = sent[0].body as { context: { messages: unknown[] } };
    expect(payload.context.messages).toEqual([{ role: 'user', content: 'plain', timestamp: 1 }]);
  });

  it('strips on an adapter that rebuilds the block too, so the rule is not per-api', async () => {
    await request('anthropic-messages', riddenMessages());

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].body)).not.toContain('aiclient');
  });
});

describe('stripAiclientKeys', () => {
  it('returns the same reference when there is nothing to strip', () => {
    const context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
    expect(stripAiclientKeys(context)).toBe(context);
  });

  it('keeps a provider field that merely starts with the same letters', () => {
    const value = { aiclientele: 1, aiclientName: 'x' };
    expect(stripAiclientKeys(value)).toEqual({ aiclientele: 1 });
  });

  it('covers both riders in the repo, so a third one cannot be missed', () => {
    // The strip rule and the rider modules have no import between them; this is
    // what keeps them in step.
    expect(Object.keys(attachmentNameRider('a.png')).every(isAiclientKey)).toBe(true);
    expect(Object.keys(internalMessageMark('subagent-report')).every(isAiclientKey)).toBe(true);
  });
});
