import { describe, expect, it } from 'vitest';
import { withUserContentBlocks } from '../userContentBlocks.ts';

/**
 * Decision 182 (DA-3): every user message's string content goes out as the
 * one text block it stands for, so that a message keeps one form from request
 * to request. The bodies are shaped the way pi-ai's anthropic-messages
 * serializer builds them: earlier user messages as strings, the last one as a
 * marked text block, and, on a row that switches effort, `{role: "system",
 * content: [], output_config}` entries before an assistant message.
 */

const MARK = { type: 'ephemeral', ttl: '1h' };

function body(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    messages,
    max_tokens: 128_000,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.', cache_control: MARK }],
    ...overrides,
  };
}

const CONTEXT = { role: 'user', content: '<context>cwd: /work</context>' };
const INPUT = 'Read the README: say "}" and \\ then 渠道.';
const TOOL_USE = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'README.md' } }],
};
const TOOL_RESULT = {
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Hello.', cache_control: MARK },
  ],
};

describe('withUserContentBlocks', () => {
  it('turns each string user content into one text block with the same text', () => {
    const source = body([CONTEXT, { role: 'user', content: INPUT }, TOOL_USE, TOOL_RESULT]);
    const before = JSON.stringify(source);
    const result = withUserContentBlocks(source);
    expect(result).toEqual(
      body([
        { role: 'user', content: [{ type: 'text', text: CONTEXT.content }] },
        { role: 'user', content: [{ type: 'text', text: INPUT }] },
        TOOL_USE,
        TOOL_RESULT,
      ])
    );
    // The body it was given is left as it was; the rest is shared, not copied.
    expect(JSON.stringify(source)).toBe(before);
    expect(result?.system).toBe(source.system);
    const messages = result?.messages as unknown[];
    expect(messages[2]).toBe(TOOL_USE);
    expect(messages[3]).toBe(TOOL_RESULT);
  });

  it('keeps every key where it was, in the body and in the message', () => {
    const message = { content: INPUT, role: 'user', extra: 1 };
    const result = withUserContentBlocks(body([message]));
    expect(Object.keys(result ?? {})).toEqual([
      'model',
      'messages',
      'max_tokens',
      'stream',
      'system',
    ]);
    expect(Object.keys((result?.messages as Array<Record<string, unknown>>)[0] ?? {})).toEqual([
      'content',
      'role',
      'extra',
    ]);
    // The text goes out byte for byte: only the wrapping around it is new.
    const sent = JSON.stringify(result);
    const asString = JSON.stringify(body([message]));
    expect(sent).toBe(
      asString.replace(
        `"content":${JSON.stringify(INPUT)}`,
        `"content":[{"type":"text","text":${JSON.stringify(INPUT)}}]`
      )
    );
  });

  it('leaves an empty or blank string alone: the API refuses an empty text block', () => {
    for (const content of ['', ' ', '\n\t ']) {
      expect(
        withUserContentBlocks(body([{ role: 'user', content }])),
        JSON.stringify(content)
      ).toBeUndefined();
    }
    const mixed = withUserContentBlocks(body([{ role: 'user', content: '' }, CONTEXT]));
    expect(mixed?.messages).toEqual([
      { role: 'user', content: '' },
      { role: 'user', content: [{ type: 'text', text: CONTEXT.content }] },
    ]);
  });

  it('leaves user content already in blocks, marks included, alone', () => {
    const marked = { role: 'user', content: [{ type: 'text', text: INPUT, cache_control: MARK }] };
    const image = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0=' } },
      ],
    };
    expect(withUserContentBlocks(body([marked, TOOL_USE, TOOL_RESULT, image]))).toBeUndefined();
  });

  it('touches no other role: assistant, system entries and unknown ones stay as they are', () => {
    const effort = { role: 'system', content: [], output_config: { effort: 'high' } };
    const others = [
      { role: 'assistant', content: 'A string answer.' },
      effort,
      { role: 'system', content: 'A string system message.' },
      { role: 'developer', content: 'Be brief.' },
      { content: 'No role at all.' },
      'not a message',
      null,
    ];
    expect(withUserContentBlocks(body(others))).toBeUndefined();
    const result = withUserContentBlocks(body([...others, CONTEXT]));
    const messages = result?.messages as unknown[];
    expect(messages.slice(0, others.length)).toEqual(others);
    expect(messages[1]).toBe(effort);
  });

  it('is idempotent: its own result needs nothing more', () => {
    const once = withUserContentBlocks(body([CONTEXT, { role: 'user', content: INPUT }]));
    expect(once).toBeDefined();
    expect(withUserContentBlocks(once)).toBeUndefined();
    expect(withUserContentBlocks(JSON.parse(JSON.stringify(once)))).toBeUndefined();
  });

  it('is undefined for anything but a body with a messages array', () => {
    for (const value of [null, undefined, 'x', 42, [], {}, { messages: 'x' }, { messages: {} }]) {
      expect(withUserContentBlocks(value), JSON.stringify(value)).toBeUndefined();
    }
    expect(withUserContentBlocks({ messages: [] })).toBeUndefined();
  });
});
