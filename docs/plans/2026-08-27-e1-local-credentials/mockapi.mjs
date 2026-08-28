// 一个本机假的 Anthropic Messages 端点,带请求头记录。
// E1 关心的不是"回了什么",而是"这一发请求带着谁的凭据来的" ——
// 每个凭据来源在夹具里写一个互不相同的哨兵值,于是"哪一路赢了"直接从头里读出来。
import { createServer } from 'node:http';

export function startMockApi({ status = 200 } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({
          url: req.url,
          authorization: req.headers.authorization ?? null,
          xApiKey: req.headers['x-api-key'] ?? null,
          bodyBytes: body.length,
        });
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type, payload) => {
          res.write(`event: ${type}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        send('message_start', { type: 'message_start', message: {
          id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe-model',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 } } });
        send('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'PROBE-DONE' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
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

/** 把哨兵值还原成"来源名",没命中就原样截断 —— 报告里不打印完整凭据。 */
export function labelOf(header, sentinels) {
  if (!header) return '(none)';
  for (const [name, value] of Object.entries(sentinels)) {
    if (header.includes(value)) return name;
  }
  return `(unknown: ${header.slice(0, 24)}…)`;
}
