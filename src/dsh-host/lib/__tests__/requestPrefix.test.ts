import { describe, expect, it } from 'vitest';
import type { ClientPrefixVerdict } from '../../../shared/types/requestScope.ts';
import {
  comparePrefix,
  type PrefixUnits,
  prefixUnitsOf,
  verdictLogFields,
} from '../requestPrefix.ts';

/**
 * Decision 173 (GitHub issue #9), B1: whether a request only extends the
 * previous request of its session. The bodies are shaped the way pi-ai's
 * anthropic-messages provider builds them (`buildParams` / `convertMessages`):
 * the system blocks and the last tool carry the cache mark, and so does the
 * last user message, turned into a text block when it is a string.
 */

const MARK = { type: 'ephemeral', ttl: '1h' };
type Message = { role: string; content: unknown };

function tool(name: string, mark = false) {
  return {
    name,
    description: `The ${name} tool.`,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    ...(mark ? { cache_control: MARK } : {}),
  };
}

/** pi-ai's mark on the last user message: on its last block, or on the block a string becomes. */
function markLastUser(messages: readonly Message[]): Message[] {
  const copy = structuredClone(messages) as Message[];
  const last = copy.at(-1);
  if (last?.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content, cache_control: MARK }];
    } else if (Array.isArray(last.content)) {
      const block = last.content.at(-1) as Record<string, unknown>;
      block.cache_control = MARK;
    }
  }
  return copy;
}

/** A request body as pi-ai sends it, in its key order. */
function request(messages: readonly Message[], overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    messages: markLastUser(messages),
    max_tokens: 128_000,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.', cache_control: MARK }],
    tools: [tool('read'), tool('bash'), tool('edit', true)],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'max' },
    ...overrides,
  };
}

/** The units of `body` as the wrapper sees it: parsed back from the wire. */
function units(body: unknown, betas?: string | null): PrefixUnits {
  const parsed = prefixUnitsOf(JSON.parse(JSON.stringify(body)), betas);
  if (parsed === undefined) throw new Error('no prefix units');
  return parsed;
}

function verdict(prev: unknown, cur: unknown, betas: [string?, string?] = []): ClientPrefixVerdict {
  return comparePrefix(units(prev, betas[0]), units(cur, betas[1]));
}

const TURN_ONE: readonly Message[] = [
  { role: 'user', content: 'Read the README.' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Look at the file first.', signature: 'c2lnLTE=' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'README.md' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Hello.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] },
  { role: 'user', content: 'Now run the tests.' },
];

const STEP_TWO: readonly Message[] = [
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Run them.', signature: 'c2lnLTI=' },
      { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'npm test' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
];

describe('prefixUnitsOf', () => {
  it('hashes config, tools, system and each message, 16 hex digits each', () => {
    const parsed = units(request(TURN_ONE), 'b-2, a-1');
    expect(Object.keys(parsed.config)).toEqual([
      'model',
      'thinking',
      'output_config',
      'anthropic-beta',
    ]);
    const hashes = [
      ...Object.values(parsed.config),
      ...parsed.tools,
      parsed.system,
      ...parsed.messages,
    ];
    expect(hashes).toHaveLength(4 + 3 + 1 + 5);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('is undefined unless the body is an object with a messages array', () => {
    for (const body of [null, undefined, 'x', 42, [], {}, { messages: 'x' }, { messages: {} }]) {
      expect(prefixUnitsOf(body), JSON.stringify(body)).toBeUndefined();
    }
    expect(prefixUnitsOf({ messages: [] })).toEqual({
      config: {},
      tools: [],
      system: expect.stringMatching(/^[0-9a-f]{16}$/),
      messages: [],
      roles: [],
    });
  });

  it('is undefined for a body JSON cannot write', () => {
    expect(prefixUnitsOf({ messages: [{ role: 'user', content: 1n }] })).toBeUndefined();
  });

  it('leaves the beta header out when there is none', () => {
    for (const betas of [undefined, null, '', ' , ']) {
      expect(Object.keys(units(request(TURN_ONE), betas).config)).not.toContain('anthropic-beta');
    }
  });
});

describe('comparePrefix', () => {
  it('calls the first request of a session first', () => {
    expect(comparePrefix(undefined, units(request(TURN_ONE)))).toEqual({ kind: 'first' });
  });

  it('sees through the moving mark on the last user message (append)', () => {
    const before = request(TURN_ONE);
    const after = request([...TURN_ONE, ...STEP_TWO]);
    // The trap is real: the same message goes out marked, then as a plain string.
    expect(before.messages[4]?.content).toEqual([
      { type: 'text', text: 'Now run the tests.', cache_control: MARK },
    ]);
    expect(after.messages[4]?.content).toBe('Now run the tests.');
    expect(verdict(before, after)).toEqual({ kind: 'append', added: 2 });
    // A tool result that is no longer last loses its mark the same way.
    const third = request([...TURN_ONE, ...STEP_TWO, { role: 'assistant', content: 'Done.' }]);
    expect(verdict(after, third)).toEqual({ kind: 'append', added: 1 });
  });

  it('calls the same request again same', () => {
    expect(verdict(request(TURN_ONE), request(TURN_ONE))).toEqual({ kind: 'same' });
  });

  it('ignores cache marks moved on system blocks and tools', () => {
    const moved = request(TURN_ONE, {
      system: [{ type: 'text', text: 'You are a coding agent.' }],
      tools: [tool('read', true), tool('bash', true), tool('edit')],
    });
    expect(verdict(request(TURN_ONE), moved)).toEqual({ kind: 'same' });
    // A string system prompt is the text block it stands for; none is an empty one.
    const asString = request(TURN_ONE, { system: 'You are a coding agent.' });
    expect(verdict(request(TURN_ONE), asString)).toEqual({ kind: 'same' });
    const { system: _dropped, ...withoutSystem } = request(TURN_ONE);
    expect(verdict(withoutSystem, request(TURN_ONE, { system: [] }))).toEqual({ kind: 'same' });
  });

  it('ignores metadata, max_tokens, stream and temperature', () => {
    const changed = request(TURN_ONE, {
      metadata: { user_id: '{"session_id":"x"}' },
      max_tokens: 1024,
      stream: false,
      temperature: 0.2,
    });
    expect(verdict(request(TURN_ONE), changed)).toEqual({ kind: 'same' });
  });

  it('names the config field that changed', () => {
    const counts = { truncated: false, prevMessages: 5, messages: 5 };
    expect(
      verdict(request(TURN_ONE), request(TURN_ONE, { thinking: { type: 'disabled' } }))
    ).toEqual({ kind: 'diverged', at: 'config', field: 'thinking', ...counts });
    expect(
      verdict(request(TURN_ONE), request(TURN_ONE, { tool_choice: { type: 'auto' } }))
    ).toEqual({ kind: 'diverged', at: 'config', field: 'tool_choice', ...counts });
    // A field added later is config too, and so is one that goes away.
    expect(
      verdict(request(TURN_ONE), request(TURN_ONE, { fallbacks: [{ model: 'claude-x' }] }))
    ).toEqual({ kind: 'diverged', at: 'config', field: 'fallbacks', ...counts });
    const { output_config: _gone, ...lessConfig } = request(TURN_ONE);
    expect(verdict(request(TURN_ONE), lessConfig)).toEqual({
      kind: 'diverged',
      at: 'config',
      field: 'output_config',
      ...counts,
    });
    // The first one in the request's order, ahead of everything else.
    expect(
      verdict(
        request(TURN_ONE),
        request([...TURN_ONE, ...STEP_TWO], {
          model: 'claude-sonnet-5',
          thinking: { type: 'disabled' },
          system: 'Another prompt.',
        })
      )
    ).toEqual({ ...counts, kind: 'diverged', at: 'config', field: 'model', messages: 7 });
  });

  it('reads the beta list as a set, and a change to it as config', () => {
    expect(verdict(request(TURN_ONE), request(TURN_ONE), ['a-1,b-2', ' b-2 , a-1,a-1'])).toEqual({
      kind: 'same',
    });
    expect(verdict(request(TURN_ONE), request(TURN_ONE), ['a-1', 'a-1,c-3'])).toMatchObject({
      kind: 'diverged',
      at: 'config',
      field: 'anthropic-beta',
    });
    expect(verdict(request(TURN_ONE), request(TURN_ONE), ['a-1', undefined])).toMatchObject({
      kind: 'diverged',
      at: 'config',
      field: 'anthropic-beta',
    });
  });

  it('names the first tool that changed, a moved, added or reordered one included', () => {
    const counts = { truncated: false, prevMessages: 5, messages: 5 };
    expect(
      verdict(
        request(TURN_ONE),
        request(TURN_ONE, { tools: [tool('bash'), tool('read'), tool('edit', true)] })
      )
    ).toEqual({ kind: 'diverged', at: 'tools', index: 0, ...counts });
    expect(
      verdict(
        request(TURN_ONE),
        request(TURN_ONE, { tools: [tool('read'), tool('bash'), tool('edit'), tool('grep', true)] })
      )
    ).toEqual({ kind: 'diverged', at: 'tools', index: 3, ...counts });
    // Key order reaches the prompt, so it is hashed.
    const reordered = tool('bash');
    const { input_schema, ...rest } = reordered;
    expect(
      verdict(
        request(TURN_ONE),
        request(TURN_ONE, { tools: [tool('read'), { input_schema, ...rest }, tool('edit', true)] })
      )
    ).toEqual({ kind: 'diverged', at: 'tools', index: 1, ...counts });
  });

  it('reports a changed system prompt', () => {
    expect(verdict(request(TURN_ONE), request(TURN_ONE, { system: 'Be brief.' }))).toEqual({
      kind: 'diverged',
      at: 'system',
      truncated: false,
      prevMessages: 5,
      messages: 5,
    });
  });

  it('names the first message that changed, and its role', () => {
    const edited = structuredClone(TURN_ONE) as Message[];
    edited[2] = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Goodbye.' }],
    };
    expect(verdict(request(TURN_ONE), request([...edited, ...STEP_TWO]))).toEqual({
      kind: 'diverged',
      at: 'messages',
      index: 2,
      role: 'user',
      truncated: false,
      prevMessages: 5,
      messages: 7,
    });
    // Thinking blocks and their signatures are hashed as they are.
    const resigned = structuredClone(TURN_ONE) as Message[];
    (resigned[1]?.content as Array<Record<string, unknown>>)[0] = {
      type: 'thinking',
      thinking: 'Look at the file first.',
      signature: 'c2lnLTk=',
    };
    expect(verdict(request(TURN_ONE), request(resigned))).toMatchObject({
      kind: 'diverged',
      at: 'messages',
      index: 1,
      role: 'assistant',
      truncated: false,
    });
  });

  it('calls history cut short truncated, and a rewind that goes on diverged', () => {
    const before = request([...TURN_ONE, ...STEP_TWO]);
    expect(verdict(before, request(TURN_ONE.slice(0, 3)))).toEqual({
      kind: 'diverged',
      at: 'messages',
      index: 3,
      // The first message the shorter request no longer has.
      role: 'assistant',
      truncated: true,
      prevMessages: 7,
      messages: 3,
    });
    const rewound = [...TURN_ONE.slice(0, 3), { role: 'user', content: 'Try again.' }];
    expect(verdict(before, request(rewound))).toEqual({
      kind: 'diverged',
      at: 'messages',
      index: 3,
      role: 'user',
      truncated: false,
      prevMessages: 7,
      messages: 4,
    });
  });
});

describe('verdictLogFields', () => {
  it('states a verdict in fields, never a hash or content', () => {
    const before = request(TURN_ONE);
    const lines = [
      verdictLogFields(comparePrefix(undefined, units(before))),
      verdictLogFields(verdict(before, request(TURN_ONE))),
      verdictLogFields(verdict(before, request([...TURN_ONE, ...STEP_TWO]))),
      verdictLogFields(verdict(before, request(TURN_ONE, { thinking: { type: 'disabled' } }))),
      verdictLogFields(verdict(before, request(TURN_ONE, { tools: [tool('read')] }))),
      verdictLogFields(verdict(before, request(TURN_ONE, { system: 'Be brief.' }))),
      verdictLogFields(verdict(request([...TURN_ONE, ...STEP_TWO]), request(TURN_ONE))),
    ];
    expect(lines).toEqual([
      'verdict=first',
      'verdict=same',
      'verdict=append added=2',
      'verdict=diverged at=config field=thinking',
      'verdict=diverged at=tools index=1',
      'verdict=diverged at=system',
      'verdict=diverged at=messages index=5/5 role=assistant truncated=true',
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/[0-9a-f]{16}/);
      expect(line).not.toMatch(/README|hello|tests|coding agent/i);
    }
  });

  it('writes the message index out of the current count', () => {
    expect(
      verdictLogFields({
        kind: 'diverged',
        at: 'messages',
        index: 41,
        role: 'assistant',
        truncated: false,
        prevMessages: 70,
        messages: 72,
      })
    ).toBe('verdict=diverged at=messages index=41/72 role=assistant truncated=false');
  });

  it('writes ? for a name unfit for a log line', () => {
    const base = { kind: 'diverged', truncated: false, prevMessages: 1, messages: 1 } as const;
    expect(verdictLogFields({ ...base, at: 'config', field: 'odd field\nX: 1' })).toBe(
      'verdict=diverged at=config field=?'
    );
    expect(verdictLogFields({ ...base, at: 'messages', index: 0, role: '' })).toBe(
      'verdict=diverged at=messages index=0/1 role=? truncated=false'
    );
  });
});
