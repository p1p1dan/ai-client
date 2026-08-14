/**
 * ON-position (`includePartialMessages: true`) SDK transcript, reconstructed
 * from the spike's two decisive excerpts
 * (`docs/plans/2026-08-11-partial-messages-spike.md` §2).
 *
 * Why a builder instead of a checked-in JSON blob: the load-bearing facts are
 * the COUNTS and the ORDERING, and the real capture carries 53 thinking
 * fragments, 46 text fragments and 22 `partial_json` fragments. Hand-writing
 * 143 stream events would be unreviewable, and shrinking them would make the
 * event-budget assertion (1e) meaningless — with a toy fixture the fixed
 * per-turn overhead dominates and any coalescer, or none, passes.
 *
 * Every structural fact below is quoted from the spike:
 *  - 摘录 A: `message_start` → `content_block_start` → deltas → **whole
 *    `assistant` carrying exactly ONE block** → `content_block_stop`, with the
 *    whole event always directly before its block's stop (gap ≡ 1); one
 *    `message_delta` per API message carrying that message's `output_tokens`;
 *    a `tool_use` `content_block_start` whose `input` is the empty object and
 *    whose real arguments only exist as `input_json_delta.partial_json`.
 *  - 摘录 B: `system/thinking_tokens` immediately BEFORE each `thinking_delta`
 *    (near 1:1), and a trailing `signature_delta` closing the thinking block.
 *  - §1 Q4: two API messages, 51 + 30 = the result event's 81 output tokens.
 *
 * The concatenation invariants the probe verified byte-for-byte hold here by
 * construction: the fragments ARE the whole strings, split.
 */

export const TREATMENT_SESSION_ID = 'sess-partial';
export const TREATMENT_REQUEST_ID = 'req-partial';
export const TREATMENT_USER_TEXT = 'Run the echo probe and tell me what it printed.';
export const TREATMENT_MODEL = 'claude-opus-4-8';

export const MESSAGE_ID_1 = 'msg_011Cdvd42oZfZYZW2Uq84Xk7';
export const MESSAGE_ID_2 = 'msg_011Cdvd4RfUhsMkYZAm4JUBv';
export const TOOL_CALL_ID = 'toolu_01JXWUDQPartialFixture01';

/** 摘录 B seq 112: 512 chars of summarized thinking, streamed as 53 fragments. */
export const THINKING_WHOLE =
  'The user wants the echo probe run and then a short report of what it ' +
  'printed. That is a single Bash call with a literal string, so there is no ' +
  'ambiguity about which command to build and no need for a plan or a todo ' +
  'list. I should keep the preamble to one sentence, run the tool, and then ' +
  'quote the exact output rather than paraphrasing it, because the point of ' +
  'the probe is the literal bytes it produced.';

/** 摘录 B seq 111: the signature fragment that closes a thinking block. */
export const THINKING_SIGNATURE = `EqADCkYIBRgCKkB${'0123456789abcdef'.repeat(20)}EgxSignature`;

/** 摘录 A seq 8: the whole text block, streamed as 46 fragments. */
export const TEXT_WHOLE_1 =
  "I'll run the command now. It is a single echo with a literal argument, so " +
  'there is nothing to configure first and nothing that can touch the working ' +
  'tree. Once it returns I will report exactly what came back on stdout, ' +
  'including the trailing newline if there is one, so the output can be ' +
  'compared against the probe expectation without any guessing.';

/** 摘录 A seq 48: the second API message's whole text, streamed as 7 fragments. */
export const TEXT_WHOLE_2 = 'It printed: partial-probe streaming fixture, exactly as expected.';

/** 摘录 A seq 33: the real tool input, which only the whole message carries. */
export const TOOL_INPUT = {
  command: 'echo "partial-probe streaming fixture"',
  description: 'Echo a probe string',
};

export const TOOL_RESULT_TEXT = 'partial-probe streaming fixture\n';

export const THINKING_FRAGMENT_COUNT = 53;
export const TEXT_1_FRAGMENT_COUNT = 46;
export const TEXT_2_FRAGMENT_COUNT = 7;
export const TOOL_JSON_FRAGMENT_COUNT = 22;

/**
 * Split into exactly `pieces` non-empty fragments covering the whole string.
 * Non-empty matters: the normalizer skips falsy delta text, so an empty
 * fragment would silently break the "fragments concatenate to the whole"
 * property this fixture exists to exercise.
 */
export function chunkInto(source: string, pieces: number): string[] {
  if (pieces < 1) throw new Error('pieces must be >= 1');
  if (source.length < pieces) {
    throw new Error(`cannot split ${source.length} chars into ${pieces} non-empty fragments`);
  }
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < pieces; i += 1) {
    const size = Math.ceil((source.length - cursor) / (pieces - i));
    out.push(source.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

type SdkMessage = Record<string, unknown>;

function streamEvent(event: Record<string, unknown>): SdkMessage {
  return { type: 'stream_event', parent_tool_use_id: null, session_id: 'rt-partial', event };
}

function wholeAssistant(messageId: string, block: Record<string, unknown>): SdkMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'rt-partial',
    message: { id: messageId, role: 'assistant', model: TREATMENT_MODEL, content: [block] },
  };
}

export interface TreatmentOptions {
  /**
   * Drop the whole `assistant` message that carries the tool_use block —
   * the "gateway stopped honouring the whole stream mid-turn" degradation
   * that the orphan back-fill (1c) exists for.
   */
  omitWholeToolMessage?: boolean;
}

/** The full two-message turn. */
export function buildTreatmentMessages(options: TreatmentOptions = {}): SdkMessage[] {
  const messages: SdkMessage[] = [];
  const toolInputJson = JSON.stringify(TOOL_INPUT);

  messages.push({ type: 'system', subtype: 'init', session_id: 'rt-partial' });
  messages.push({
    type: 'system',
    subtype: 'status',
    session_id: 'rt-partial',
    status: 'requesting',
  });

  // --- API message 1: thinking block, text block, tool_use block -----------
  messages.push(
    streamEvent({
      type: 'message_start',
      message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL, usage: { input_tokens: 2883 } },
    })
  );

  messages.push(
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
  );
  let estimated = 0;
  for (const fragment of chunkInto(THINKING_WHOLE, THINKING_FRAGMENT_COUNT)) {
    // 摘录 B: the tick lands BEFORE its delta, near 1:1.
    const delta = 2;
    estimated += delta;
    messages.push({
      type: 'system',
      subtype: 'thinking_tokens',
      session_id: 'rt-partial',
      estimated_tokens: estimated,
      estimated_tokens_delta: delta,
    });
    messages.push(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: fragment, estimated_tokens: null },
      })
    );
  }
  messages.push(
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: THINKING_SIGNATURE },
    })
  );
  messages.push(
    wholeAssistant(MESSAGE_ID_1, {
      type: 'thinking',
      thinking: THINKING_WHOLE,
      signature: THINKING_SIGNATURE,
    })
  );
  messages.push(streamEvent({ type: 'content_block_stop', index: 0 }));

  messages.push(
    streamEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    })
  );
  for (const fragment of chunkInto(TEXT_WHOLE_1, TEXT_1_FRAGMENT_COUNT)) {
    messages.push(
      streamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: fragment },
      })
    );
  }
  messages.push(wholeAssistant(MESSAGE_ID_1, { type: 'text', text: TEXT_WHOLE_1 }));
  messages.push(streamEvent({ type: 'content_block_stop', index: 1 }));

  messages.push(
    streamEvent({
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: TOOL_CALL_ID,
        name: 'Bash',
        // 雷 B, spike §1 Q3: the stub's input is the EMPTY object.
        input: {},
        caller: { type: 'direct' },
      },
    })
  );
  for (const fragment of chunkInto(toolInputJson, TOOL_JSON_FRAGMENT_COUNT)) {
    messages.push(
      streamEvent({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: fragment },
      })
    );
  }
  if (!options.omitWholeToolMessage) {
    messages.push(
      wholeAssistant(MESSAGE_ID_1, {
        type: 'tool_use',
        id: TOOL_CALL_ID,
        name: 'Bash',
        input: TOOL_INPUT,
      })
    );
  }
  messages.push(streamEvent({ type: 'content_block_stop', index: 2 }));
  messages.push(
    streamEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: {
        input_tokens: 2883,
        output_tokens: 51,
        output_tokens_details: { thinking_tokens: 0 },
      },
    })
  );
  messages.push(streamEvent({ type: 'message_stop' }));

  messages.push({
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'rt-partial',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_CALL_ID,
          content: TOOL_RESULT_TEXT,
          is_error: false,
        },
      ],
    },
  });
  messages.push({
    type: 'system',
    subtype: 'status',
    session_id: 'rt-partial',
    status: 'requesting',
  });

  // --- API message 2: text only -------------------------------------------
  messages.push(
    streamEvent({
      type: 'message_start',
      message: { id: MESSAGE_ID_2, model: TREATMENT_MODEL, usage: { input_tokens: 2971 } },
    })
  );
  messages.push(
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
  );
  for (const fragment of chunkInto(TEXT_WHOLE_2, TEXT_2_FRAGMENT_COUNT)) {
    messages.push(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: fragment },
      })
    );
  }
  messages.push(wholeAssistant(MESSAGE_ID_2, { type: 'text', text: TEXT_WHOLE_2 }));
  messages.push(streamEvent({ type: 'content_block_stop', index: 0 }));
  messages.push(
    streamEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 2971, output_tokens: 30 },
    })
  );
  messages.push(streamEvent({ type: 'message_stop' }));

  messages.push({
    type: 'result',
    subtype: 'success',
    session_id: 'rt-partial',
    is_error: false,
    result: TEXT_WHOLE_2,
    usage: {
      input_tokens: 2971,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      // §1 Q4: 51 + 30, the sum the Host must reproduce on its own.
      output_tokens: 81,
      output_tokens_details: { thinking_tokens: 0 },
    },
  });

  return messages;
}
