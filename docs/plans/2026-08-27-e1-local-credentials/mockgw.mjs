// 本机假的 OpenAI Responses 端点,带请求头记录。
// 与 mockapi.mjs 同一个用途,换成 codex 说的那套协议:回三帧 SSE 让回合能跑完,
// 顺便把每一发请求的 authorization 头记下来 —— "谁的凭据上了车"就是这里读出来的。
import { createServer } from 'node:http';

export function startMockGateway({ status = 200 } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({
          url: req.url,
          authorization: req.headers.authorization ?? null,
          bodyBytes: body.length,
        });
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        send({ type: 'response.created', response: { id: 'resp_probe', status: 'in_progress' } });
        send({ type: 'response.output_item.done', item: {
          type: 'message', role: 'assistant', id: 'msg_probe',
          content: [{ type: 'output_text', text: 'PROBE-DONE' }] } });
        send({ type: 'response.completed', response: {
          id: 'resp_probe', status: 'completed',
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() });
    });
  });
}
