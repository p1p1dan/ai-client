/**
 * F4 点验：provider 重试层在真实 HTTP 上到底走不走。
 *
 * ## 为什么单测不够
 *
 * `src/runtime/__tests__/agentLoop.test.ts` 里那条重试用例用的是 pi-ai 的
 * `fauxProvider`，让它 `throw new Error('503: service unavailable')`。那证明了
 * 「流没开始就失败时会重来一次」，但它走的是**按异常文本分类**那条路。真实网关
 * 交回来的是一个带状态码和响应头的 HTTP 响应，`classifyProviderFailure` 读的是
 * status 与 `Retry-After`——完全是另一段代码。现场那条「503 不重试直接失败」就发生
 * 在真实 HTTP 上，所以点验也必须发生在真实 HTTP 上。
 *
 * ## 做法
 *
 * 起一个本地 HTTP 服务假扮 Anthropic Messages 网关，按脚本逐次返回 503 / 429 /
 * 正常 SSE，再用**真的** `createRuntime` 指过去（临时 agent 目录里放一份
 * `models.json` + `auth.json`，走的是 `readPiCatalog` 那条真路径）。不起 Electron：
 * 要验的是 runtime 这一层，而这台机器上少起一次 Electron 是实打实的。
 *
 * 四条路：
 *  1. 503 两次后成功 —— 回合最终成功，trace 里有两条 provider_retry（等 3s、10s）
 *  2. 一直 503 —— 预算耗尽后失败，且失败前确实试满了 4 次（3s / 10s / 30s 三次重试）
 *  3. 429 带 Retry-After —— 走的是 429 那条单独预算，且按服务端给的秒数等
 *  4. 退避途中取消 —— 立刻结束为 aborted，不把梯子走完
 *
 *   node scripts/run-f4-retry-probe.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p4-6/f4-retry');

const MODEL = { provider: 'fakegw', id: 'fake-1' };

/** 一段最小但完整的 Anthropic Messages SSE 应答。 */
function successBody(text) {
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_f4',
          type: 'message',
          role: 'assistant',
          model: MODEL.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/**
 * 假网关。
 *
 * `plan` 是一串应答描述，第 n 个请求用第 n 项；用完之后重复最后一项，这样「一直
 * 503」不用写五遍。每个请求都记下来，供判据核对**真实到达了几次**——只看 trace
 * 的话，一个根本没发出去的重试和一个发出去又失败的重试长得一样。
 */
function startGateway(plan) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const step = plan[Math.min(requests.length, plan.length - 1)];
    requests.push({ at: Date.now(), url: req.url, step: step.kind });
    // 请求体要排干才会触发 end；内容本身用不上，判据只看到达次数和时序。
    req.resume();
    req.on('end', () => {
      if (step.kind === 'ok') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(successBody(step.text ?? 'recovered'));
        return;
      }
      const headers = { 'content-type': 'application/json', ...(step.headers ?? {}) };
      res.writeHead(step.status, headers);
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: `fake gateway ${step.status}` },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-agent-'));
  fs.writeFileSync(
    path.join(dir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          [MODEL.provider]: {
            name: 'Fake gateway',
            baseUrl,
            api: 'anthropic-messages',
            models: [{ id: MODEL.id, name: 'Fake 1' }],
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({ [MODEL.provider]: { type: 'api_key', key: 'fake-key' } }, null, 2)
  );
  return dir;
}

/** trace 里这一轮记下的 provider_retry 备注。 */
function retryNotes(runtime) {
  const run = runtime.trace.runs.at(-1);
  return (run?.steps ?? [])
    .filter((step) => step.type === 'note' && step.detail?.event === 'provider_retry')
    .map((step) => ({
      code: step.detail.code,
      attempt: step.detail.attempt,
      delay_ms: step.detail.delay_ms,
      ...(step.detail.retry_after_ms !== undefined
        ? { retry_after_ms: step.detail.retry_after_ms }
        : {}),
    }));
}

async function scenario(name, plan, body) {
  const gateway = await startGateway(plan);
  const agentDir = writeAgentDir(gateway.baseUrl);
  const { createRuntime } = await import('../src/runtime/bootstrap.ts');
  const runtime = await createRuntime({ agentDir, env: { ...process.env } });
  const started = Date.now();
  try {
    const result = await body(runtime, gateway);
    return {
      name,
      elapsedMs: Date.now() - started,
      requestCount: gateway.requests.length,
      retries: retryNotes(runtime),
      result: {
        success: result.success,
        text: result.text,
        stopReason: result.stopReason,
        error: result.error ?? null,
      },
    };
  } finally {
    await runtime.dispose();
    await gateway.close();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

async function main() {
  const report = { scenarios: {} };

  // ① 503 两次之后成功。
  report.scenarios.retryThenSucceed = await scenario(
    'retry-then-succeed',
    [
      { kind: 'fail', status: 503 },
      { kind: 'fail', status: 503 },
      { kind: 'ok', text: 'recovered' },
    ],
    (runtime) => runtime.run({ prompt: 'say ready', systemPrompt: 'f4 probe', model: MODEL })
  );

  // ② 一直 503：预算耗尽。
  report.scenarios.budgetExhausted = await scenario(
    'budget-exhausted',
    [{ kind: 'fail', status: 503 }],
    (runtime) => runtime.run({ prompt: 'say ready', systemPrompt: 'f4 probe', model: MODEL })
  );

  // ③ 429 带 Retry-After：另一条预算，且听服务端的。
  report.scenarios.rateLimited = await scenario(
    'rate-limited',
    [
      { kind: 'fail', status: 429, headers: { 'retry-after': '1' } },
      { kind: 'ok', text: 'after rate limit' },
    ],
    (runtime) => runtime.run({ prompt: 'say ready', systemPrompt: 'f4 probe', model: MODEL })
  );

  // ④ 退避途中取消。第一次 503 之后要等 3 秒，在这 3 秒里 abort。
  report.scenarios.cancelledDuringBackoff = await scenario(
    'cancelled-during-backoff',
    [{ kind: 'fail', status: 503 }],
    (runtime) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 400);
      return runtime.run({
        prompt: 'say ready',
        systemPrompt: 'f4 probe',
        model: MODEL,
        signal: controller.signal,
      });
    }
  );

  const s = report.scenarios;
  report.verdict = {
    // 判据要同时看 trace 和真实请求数：只看 trace 的话，一个根本没发出去的重试
    // 和一个发出去又失败的重试长得一样。
    retriedAndRecovered:
      s.retryThenSucceed.result.success === true &&
      s.retryThenSucceed.result.text.includes('recovered') &&
      s.retryThenSucceed.retries.length === 2 &&
      s.retryThenSucceed.requestCount === 3 &&
      s.retryThenSucceed.retries.map((r) => r.delay_ms).join(',') === '3000,10000',
    // 2026-09-11 用户把退避改成 3s / 10s / 30s，三次重试、四次尝试。
    exhaustsBudgetThenFails:
      s.budgetExhausted.result.success === false &&
      s.budgetExhausted.retries.length === 3 &&
      s.budgetExhausted.requestCount === 4 &&
      s.budgetExhausted.retries.map((r) => r.delay_ms).join(',') === '3000,10000,30000',
    // delay 是 1000 而不是 429 那条预算自己的起步值 2000，说明服务端给的
    // `Retry-After: 1` 被采纳了——这一条才是「按服务端节奏走」的判据。
    rateLimitHasItsOwnBudget:
      s.rateLimited.result.success === true &&
      s.rateLimited.retries.length === 1 &&
      s.rateLimited.retries[0]?.code === 'PROVIDER_RATE_LIMITED' &&
      s.rateLimited.retries[0]?.delay_ms === 1_000,
    // 第一档退避是 3 秒，第 400ms 取消；要是 abort 打断不了退避里的 sleep，
    // 这一格就会变成 43 秒。
    cancelStopsTheLadder:
      s.cancelledDuringBackoff.result.success === false &&
      s.cancelledDuringBackoff.result.stopReason === 'aborted' &&
      s.cancelledDuringBackoff.requestCount === 1 &&
      s.cancelledDuringBackoff.elapsedMs < 2_000,
  };
  report.verdict.pass = Object.values(report.verdict).every((value) => value === true);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'f4-retry-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.verdict.pass) process.exitCode = 1;
}

await main();
