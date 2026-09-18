/**
 * Prompt cache TTL: what the main loop asks for, what a delegate asks for, and
 * what either of those actually puts on the wire.
 *
 * Three layers, because the claim "the main conversation caches for an hour"
 * can fail independently at each of them:
 *
 * 1. **The wire.** `cacheRetention: 'long'` has to come out as
 *    `cache_control: {type:'ephemeral', ttl:'1h'}` in the Anthropic request
 *    body. Asserted through a recording fetch, the same technique
 *    `catalog.test.ts` uses, because a value that is merely present on an
 *    options object is not a request.
 * 2. **The parent loop.** The loop's own `streamFn` has to inject its
 *    configured retention, and a request that never named one used to fall
 *    through to pi-ai's `short` default.
 * 3. **The delegate.** A delegate constructs its own `Agent` with its own
 *    `streamFn`, so it does NOT inherit the parent's value — which is the whole
 *    reason the two are separate settings. The end-to-end case is what proves
 *    the parent's hour did not leak into it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage,
  CacheRetention,
  Context as PiContext,
  Provider,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { buildProviderModels } from '../plugins/model-adapter/binding.ts';
import type { CatalogModel, CatalogProvider } from '../plugins/model-adapter/catalog.ts';
import { SUBAGENT_TOOL_NAME } from '../plugins/subagent/index.ts';
import { DEFAULT_SUBAGENT_CACHE_RETENTION } from '../plugins/subagent/run.ts';
import { neverAsked } from './fixtures/approval.ts';

// ---------------------------------------------------------------------------
// 1 · the wire
// ---------------------------------------------------------------------------

interface RecordedRequest {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

describe('what a retention choice puts on an Anthropic request', () => {
  const sent: RecordedRequest[] = [];

  const recordingFetch: typeof fetch = async (input, init) => {
    void input;
    const headers = new Headers(
      (init?.headers ?? undefined) as ConstructorParameters<typeof Headers>[0]
    );
    sent.push({
      headers: Object.fromEntries(headers.entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    // 400 rather than a throw: the vendor SDK retries the retriable statuses
    // and this test wants exactly one request per call.
    return new Response('{"error":{"message":"recorded"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };

  beforeEach(() => {
    sent.length = 0;
  });

  function anthropicProvider(compat?: Record<string, unknown>): CatalogProvider {
    const model: CatalogModel = {
      id: 'claude-probe',
      name: 'claude-probe',
      api: 'anthropic-messages',
      reasoning: false,
      input: ['text'],
      contextWindow: 200_000,
      maxTokens: 8_192,
      ...(compat ? { compat } : {}),
    };
    return {
      id: 'claude',
      baseUrl: 'https://gateway.example/v1',
      headers: {},
      api: 'anthropic-messages',
      models: [model],
      apiKey: 'sk-test',
    };
  }

  async function request(
    provider: CatalogProvider,
    cacheRetention: CacheRetention
  ): Promise<RecordedRequest> {
    const models = buildProviderModels(provider);
    const model = models.getModel(provider.id, 'claude-probe');
    if (!model) throw new Error('no probe model');
    await models
      .streamSimple(
        model,
        {
          systemPrompt: 'a system prompt long enough to be worth caching',
          messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        },
        { fetch: recordingFetch, maxRetries: 0, cacheRetention }
      )
      .result();
    expect(sent).toHaveLength(1);
    return sent[0];
  }

  /** The `cache_control` the system prompt block carried, or undefined. */
  function systemCacheControl(recorded: RecordedRequest): Record<string, unknown> | undefined {
    const system = recorded.body.system as
      | { cache_control?: Record<string, unknown> }[]
      | undefined;
    return system?.[0]?.cache_control;
  }

  it("sends ttl '1h' for long retention", async () => {
    const recorded = await request(anthropicProvider(), 'long');
    expect(systemCacheControl(recorded)).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('sends a plain ephemeral breakpoint (no ttl) for short retention', async () => {
    const recorded = await request(anthropicProvider(), 'short');
    expect(systemCacheControl(recorded)).toEqual({ type: 'ephemeral' });
  });

  it('drops the breakpoint entirely for none', async () => {
    const recorded = await request(anthropicProvider(), 'none');
    expect(systemCacheControl(recorded)).toBeUndefined();
  });

  /**
   * The compat gate, which is what makes "we asked for an hour" and "the model
   * can serve an hour" two different statements. Our shipped catalog sets no
   * `supportsLongCacheRetention`, so every row defaults to true — this case
   * pins the behaviour of the flag a future catalog could set.
   */
  it('falls back to a plain breakpoint when the row says it cannot do long retention', async () => {
    const recorded = await request(
      anthropicProvider({ supportsLongCacheRetention: false }),
      'long'
    );
    expect(systemCacheControl(recorded)).toEqual({ type: 'ephemeral' });
  });

  /**
   * Recorded, not required. Anthropic's 1h TTL is generally available and the
   * SDK sends no `extended-cache-ttl-2025-04-11`; this case exists so that a
   * future pi-ai bump which starts (or needs to start) sending it shows up as a
   * changed expectation rather than as a silent five-minute cache.
   */
  it('does not send the extended-cache-ttl beta header', async () => {
    const recorded = await request(anthropicProvider(), 'long');
    expect(recorded.headers['anthropic-beta'] ?? '').not.toContain('extended-cache-ttl');
  });

  /**
   * The observability half: a relay that quietly downgrades `ttl:"1h"` to five
   * minutes answers with a 200 and a normal-looking usage block, so the REQUEST
   * side proves nothing on its own. Anthropic splits the cache write by TTL in
   * `usage.cache_creation`, and pi-ai keeps the 1h leg as `usage.cacheWrite1h` —
   * which the loop then sums and writes verbatim into `runs.jsonl`'s `llm`
   * steps. This case is what makes that field a measurement rather than a
   * reading of the SDK source: it feeds a real streamed response through the
   * real adapter and asserts the bucket survives.
   *
   * The 5m leg is not carried separately; it is `cacheWrite - cacheWrite1h`.
   */
  it('keeps the 1h leg of the cache write out of the response usage', async () => {
    const usage = {
      input_tokens: 11,
      output_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 20 },
    };
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-probe', usage, content: [] },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const streamingFetch: typeof fetch = async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const provider = anthropicProvider();
    const models = buildProviderModels(provider);
    const model = models.getModel(provider.id, 'claude-probe');
    if (!model) throw new Error('no probe model');
    const message = await models
      .streamSimple(
        model,
        {
          systemPrompt: 'probe',
          messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        },
        { fetch: streamingFetch, maxRetries: 0, cacheRetention: 'long' }
      )
      .result();

    expect(message.usage.cacheWrite).toBe(100);
    expect(message.usage.cacheWrite1h).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3 · the loop and the delegate
// ---------------------------------------------------------------------------

/** One request the graph made, tagged with which loop made it. */
interface SeenRequest {
  delegate: boolean;
  cacheRetention: CacheRetention | undefined;
}

/**
 * A faux provider whose `streamSimple` records the retention it was handed.
 *
 * Routing is by system prompt, the same tell `subagentDelegation.test.ts` uses:
 * a delegate's prompt opens with `You are the "<name>" subagent`.
 */
function recordingProvider(
  script: { parent: (() => AssistantMessage)[]; delegate: (() => AssistantMessage)[] },
  seen: SeenRequest[]
): Provider {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-cache', name: 'cache probe' }],
  });
  let parentIndex = 0;
  let delegateIndex = 0;
  handle.setResponses(
    Array.from({ length: 32 }, () => (context: PiContext) => {
      const delegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
      const steps = delegate ? script.delegate : script.parent;
      const index = delegate ? delegateIndex++ : parentIndex++;
      const step = steps[Math.min(index, steps.length - 1)];
      if (!step) throw new Error('no scripted response');
      return step();
    })
  );
  const provider = handle.provider;
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property !== 'streamSimple') return Reflect.get(target, property, receiver);
      return (model: unknown, context: PiContext, options?: SimpleStreamOptions) => {
        seen.push({
          delegate: /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? ''),
          cacheRetention: options?.cacheRetention,
        });
        return (
          target.streamSimple as (
            model: unknown,
            context: PiContext,
            options?: SimpleStreamOptions
          ) => ReturnType<Provider['streamSimple']>
        )(model, context, options);
      };
    },
  });
}

describe('what the runtime asks the provider for', () => {
  let runtime: RuntimeHandle | undefined;
  let workspace: string;
  let seen: SeenRequest[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'cache-ttl-'));
    seen = [];
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  it('asks for long retention on the main loop by default', async () => {
    const provider = recordingProvider(
      { parent: [() => fauxAssistantMessage('ready')], delegate: [] },
      seen
    );
    runtime = await createRuntime({ env: {}, providers: [provider] });
    const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].cacheRetention).toBe('long');
  });

  it('honours a configured main-loop retention over the default', async () => {
    const provider = recordingProvider(
      { parent: [() => fauxAssistantMessage('ready')], delegate: [] },
      seen
    );
    runtime = await createRuntime({
      env: {},
      providers: [provider],
      loop: { cacheRetention: 'short' },
    });
    await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
    expect(seen[0].cacheRetention).toBe('short');
  });

  it('gives a delegate its own short retention while the parent keeps the hour', async () => {
    const provider = recordingProvider(
      {
        parent: [
          () =>
            fauxAssistantMessage(
              [fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'explorer', task: 'look' })],
              {
                stopReason: 'toolUse',
              }
            ),
          () => fauxAssistantMessage('integrated'),
        ],
        delegate: [() => fauxAssistantMessage('delegate report')],
      },
      seen
    );
    runtime = await createRuntime({
      env: {},
      providers: [provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      loop: { singleTurn: false },
    });
    const result = await runtime.run({ prompt: 'delegate this', systemPrompt: 'probe' });
    expect(result.success).toBe(true);

    const parent = seen.filter((entry) => !entry.delegate);
    const delegate = seen.filter((entry) => entry.delegate);
    expect(parent.length).toBeGreaterThan(0);
    expect(delegate.length).toBeGreaterThan(0);
    expect(new Set(parent.map((entry) => entry.cacheRetention))).toEqual(new Set(['long']));
    expect(new Set(delegate.map((entry) => entry.cacheRetention))).toEqual(
      new Set([DEFAULT_SUBAGENT_CACHE_RETENTION])
    );
  });

  it('honours a configured delegate retention', async () => {
    const provider = recordingProvider(
      {
        parent: [
          () =>
            fauxAssistantMessage(
              [fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'explorer', task: 'look' })],
              {
                stopReason: 'toolUse',
              }
            ),
          () => fauxAssistantMessage('integrated'),
        ],
        delegate: [() => fauxAssistantMessage('delegate report')],
      },
      seen
    );
    runtime = await createRuntime({
      env: {},
      providers: [provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: { home: join(workspace, 'home'), cacheRetention: 'long' },
      loop: { singleTurn: false },
    });
    await runtime.run({ prompt: 'delegate this', systemPrompt: 'probe' });
    const delegate = seen.filter((entry) => entry.delegate);
    expect(delegate.length).toBeGreaterThan(0);
    expect(new Set(delegate.map((entry) => entry.cacheRetention))).toEqual(new Set(['long']));
  });
});
