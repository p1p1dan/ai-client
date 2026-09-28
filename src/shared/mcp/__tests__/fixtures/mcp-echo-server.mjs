/**
 * A real MCP stdio server, for P5-3's end-to-end test.
 *
 * Small enough to read in one sitting and real enough that the test exercises
 * the whole path the product uses: `runtimeExec.spawn` starts an actual
 * process, the handshake goes over actual pipes, and `tools/call` comes back
 * over them. A mocked transport would prove the client's bookkeeping and
 * nothing about the carrier — which, on the encrypted Windows target, is the
 * part that breaks.
 *
 * Behaviour is switched by argv so one fixture covers several cases:
 *   (no flag)      well-behaved server with two tools
 *   --noisy        prints a non-JSON banner to stdout and a line to stderr first
 *   --paged        returns its tools across two `tools/list` pages
 *   --silent       never answers, to exercise the handshake timeout
 *   --crash-on-call exits during `tools/call`
 *   --slow-list    answers `initialize` and then never answers `tools/list`
 *   --dupes        repeats a tool across pages and offers two names that clamp alike
 *   --hang-on-call answers everything but `tools/call`, and reports cancellations
 *   --ask          sends the client a request of its own, to see if it is answered
 */

import process from 'node:process';

const flags = new Set(process.argv.slice(2));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (flags.has('--noisy')) {
  process.stdout.write('starting up, please wait\n');
  process.stderr.write('[fixture] booted\n');
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fail',
    description: 'Always reports a tool-level error',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'shot',
    description: 'Returns an image the way a screenshot server does',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        silent: { type: 'boolean' },
        bytes: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
];

/** A 1x1 PNG. Small enough to inline, real enough to be a base64 image payload. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Two tool names that differ only past the point where `mcp__<server>__<tool>`
 * gets clamped to 64 characters, so they reach the registry as one name.
 */
const CLAMP_COLLISION = [
  { name: `${'z'.repeat(60)}a`, description: 'first', inputSchema: { type: 'object' } },
  { name: `${'z'.repeat(60)}b`, description: 'second', inputSchema: { type: 'object' } },
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

function handle(message) {
  if (flags.has('--silent')) return;
  if (message.id === 'srv-1' && message.error) {
    process.stderr.write(`[fixture] refused ${message.error.code}\n`);
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-fixture', version: '0.1.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') {
    // Servers must not do this; the point of the flag is what happens when one
    // does. The client declares no capabilities, so the honest answer is a
    // JSON-RPC "method not found" rather than silence the server waits out.
    if (flags.has('--ask'))
      send({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} });
    return;
  }
  if (message.method === 'notifications/cancelled') {
    process.stderr.write(`[fixture] cancelled ${message.params?.requestId}\n`);
    return;
  }
  if (message.method === 'tools/list') {
    if (flags.has('--slow-list')) return;
    if (flags.has('--dupes')) {
      send(
        message.params?.cursor
          ? // Page two repeats page one's tool and adds the clamp collision.
            { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[0], ...CLAMP_COLLISION] } }
          : { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[0]], nextCursor: 'page-2' } }
      );
      return;
    }
    if (!flags.has('--paged')) {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    }
    send(
      message.params?.cursor
        ? { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[1]] } }
        : { jsonrpc: '2.0', id: message.id, result: { tools: [TOOLS[0]], nextCursor: 'page-2' } }
    );
    return;
  }
  if (message.method === 'tools/call') {
    if (flags.has('--crash-on-call')) process.exit(3);
    if (flags.has('--hang-on-call')) return;
    if (message.params?.name === 'shot') {
      const args = message.params.arguments ?? {};
      const content = args.silent ? [] : [{ type: 'text', text: 'here is the page' }];
      // `bytes` pads the payload so a test can ask for an image that is too
      // large to forward; the padding is base64 alphabet, nobody decodes it.
      const data = args.bytes ? PIXEL.padEnd(Number(args.bytes), 'A') : PIXEL;
      for (let i = 0; i < Number(args.count ?? 1); i += 1)
        content.push({ type: 'image', data, mimeType: 'image/png' });
      send({ jsonrpc: '2.0', id: message.id, result: { content } });
      return;
    }
    if (message.params?.name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'the thing went wrong' }], isError: true },
      });
      return;
    }
    if (message.params?.name !== 'echo') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `echo: ${message.params.arguments?.text ?? ''}` }],
      },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
}
