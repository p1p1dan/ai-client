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
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
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
