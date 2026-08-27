// 一个本机假的 Anthropic Messages 端点。它一定回一个 tool_use，
// 这样「工具调用有没有过 canUseTool」就成了确定性的、可观测的事实。
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

export function startMockApi({ capturePath, toolName = 'Bash', toolInput = { command: 'rm -f ./probe-target.txt' } }) {
  return new Promise((resolve) => {
    const requests = [];
    let turn = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ url: req.url, body });
        if (capturePath) appendFileSync(capturePath, `${body}\n`);
        turn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type, payload) => {
          res.write(`event: ${type}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        send('message_start', { type: 'message_start', message: {
          id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'probe-model',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 } } });

        if (turn === 1) {
          // 第一回合：要求调用工具
          send('content_block_start', { type: 'content_block_start', index: 0,
            content_block: { type: 'tool_use', id: 'toolu_probe_1', name: toolName, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
        } else {
          // 之后：说一句就收工，免得无限循环
          send('content_block_start', { type: 'content_block_start', index: 0,
            content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text: 'PROBE-DONE' } });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
        }
        send('message_stop', { type: 'message_stop' });
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}
