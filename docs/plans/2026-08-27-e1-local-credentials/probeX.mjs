// X 组 —— Codex 侧:不注入任何东西时,随包 codex 自己能从哪里拿到凭据,以及谁赢。
// 与 L 组同一手法:每个来源一个哨兵值,provider 的 base_url 指向本机假网关,
// "这一发请求带着谁的凭据"从 authorization 头读出来。零外网。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startMockGateway } from './mockgw.mjs';

const REPO = '/home/ai/code/ai-client';
const CODEX_JS = `${REPO}/src/agent-host/node_modules/@openai/codex/bin/codex.js`;
const NODE = process.execPath;
const ROOT = process.env.PROBE_ROOT;
const TRACE_CAP = Number(process.env.PROBE_TRACE_CAP ?? 460);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);

const S = {
  'auth.json': 'SENTINEL-CODEX-AUTH-JSON',
  'env OPENAI_API_KEY': 'SENTINEL-CODEX-ENV-OPENAI',
  'config env_key -> env': 'SENTINEL-CODEX-ENV-KEY',
  'auth.json (ChatGPT tokens)': 'SENTINEL-CODEX-CHATGPT-TOKENS',
};

function labelOf(header) {
  if (!header) return '(none)';
  for (const [name, value] of Object.entries(S)) if (header.includes(value)) return name;
  return `(unknown: ${header.slice(0, 28)}…)`;
}

function fixture({ authJson, chatgptAuthJson, envKeyInConfig, requiresOpenaiAuth, builtinOpenai, baseUrl }) {
  const HOME = join(ROOT, 'x-home');
  const CWD = join(ROOT, 'x-proj');
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  rmSync(CWD, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  const id = builtinOpenai ? 'openai' : 'probe';
  const lines = [
    ...(builtinOpenai ? [] : ['model_provider = "probe"']),
    'model = "gpt-5"',
    `[model_providers.${id}]`,
    `name = ${JSON.stringify(id)}`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    `requires_openai_auth = ${requiresOpenaiAuth ? 'true' : 'false'}`,
  ];
  if (envKeyInConfig) lines.push(`env_key = ${JSON.stringify(envKeyInConfig)}`);
  // 信任本目录,否则 thread/start 会停在信任提示上,整组就没法比。
  lines.push(`[projects.${JSON.stringify(CWD)}]`, 'trust_level = "trusted"');
  writeFileSync(join(HOME, 'config.toml'), `${lines.join('\n')}\n`);
  if (authJson) writeFileSync(join(HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: S['auth.json'] }), { mode: 0o600 });
  if (chatgptAuthJson) {
    writeFileSync(join(HOME, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: S['auth.json (ChatGPT tokens)'],
        access_token: S['auth.json (ChatGPT tokens)'],
        refresh_token: `${S['auth.json (ChatGPT tokens)']}-REFRESH`,
        account_id: 'probe-account',
      },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
  }
  return { HOME, CWD };
}

function driveCodex({ HOME, CWD, env }) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CODEX_JS, 'app-server'], {
      cwd: CWD,
      env: { ...env, CODEX_HOME: HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trace = [];
    let buf = '';
    let threadId = null;
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ trace, why });
    };
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { trace.push(`nonjson: ${line.slice(0, 120)}`); continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {
            cwd: CWD, approvalPolicy: 'never', sandbox: 'read-only' } });
        } else if (msg.id === 2) {
          if (msg.error) { trace.push(`thread/start ERROR: ${JSON.stringify(msg.error).slice(0, 220)}`); finish('thread-start-error'); return; }
          threadId = msg.result?.thread?.id ?? msg.result?.threadId ?? null;
          if (!threadId) { trace.push(`thread/start 没给 id: ${JSON.stringify(msg.result).slice(0, 160)}`); finish('no-thread-id'); return; }
          send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: {
            threadId, input: [{ type: 'text', text: 'Say PROBE and stop.' }] } });
        } else if (msg.id === 3) {
          if (msg.error) { trace.push(`turn/start ERROR: ${JSON.stringify(msg.error).slice(0, 260)}`); finish('turn-start-error'); return; }
        } else if (msg.method === 'turn/completed' || msg.method === 'turn/failed') {
          trace.push(`${msg.method}: ${JSON.stringify(msg.params ?? {}).slice(0, 260)}`);
          finish(msg.method);
        } else if (msg.method === 'error' || msg.method === 'thread/error') {
          trace.push(`${msg.method}: ${JSON.stringify(msg.params ?? {}).slice(0, 260)}`);
        }
      }
    });
    child.stderr.on('data', (c) => { if (trace.length < 60) trace.push(`stderr: ${c.toString().slice(0, 200)}`); });
    child.on('error', (e) => { trace.push(`spawn error: ${e.message}`); finish('spawn-error'); });
    child.on('exit', (code) => { trace.push(`exit ${code}`); finish('exit'); });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      clientInfo: { name: 'e1-probe', title: 'E1Probe', version: '0.0.0-probe' },
      capabilities: { experimentalApi: true, requestAttestation: false } } });
  });
}

async function runAll({ label, authJson, chatgptAuthJson, envKeyInConfig, requiresOpenaiAuth, builtinOpenai, gatewayStatus = 200, processEnv = {} }) {
  const gw = await startMockGateway({ status: gatewayStatus });
  const { HOME, CWD } = fixture({ authJson, chatgptAuthJson, envKeyInConfig, requiresOpenaiAuth, builtinOpenai, baseUrl: gw.baseUrl });
  const env = { ...process.env, HOME, ...processEnv };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_HOME;
  for (const [k, v] of Object.entries(processEnv)) env[k] = v;
  const { trace, why } = await driveCodex({ HOME, CWD, env });
  gw.close();
  // 被杀的 app-server 还会往 CODEX_HOME 里写一会儿;不等它写完,下一臂的清目录会 ENOTEMPTY。
  await new Promise((r) => setTimeout(r, 700));
  const req = gw.requests[0];
  console.log('====', label);
  console.log('   请求发出去了吗 :', gw.requests.length > 0 ? `是 (${gw.requests.length} 发)` : '否');
  if (req) console.log('   authorization  :', labelOf(req.authorization));
  console.log('   收尾           :', why);
  console.log('   痕迹           :', trace.join(' | ').slice(0, TRACE_CAP) || '(无)');
}

const ONLY = process.env.PROBE_ONLY;
async function run(spec) {
  if (ONLY && !spec.label.startsWith(ONLY)) return;
  return runAll(spec);
}

await run({ label: 'X0 空 CODEX_HOME:无 auth.json、无 env、config 无 env_key —— 对照' });
await run({ label: 'X1 只有 ~/.codex/auth.json 的 OPENAI_API_KEY', authJson: true });
await run({ label: 'X2 只有进程环境变量 OPENAI_API_KEY', processEnv: { OPENAI_API_KEY: S['env OPENAI_API_KEY'] } });
await run({ label: 'X3 config.toml 的 env_key 指向一个环境变量', envKeyInConfig: 'PROBE_CUSTOM_KEY', processEnv: { PROBE_CUSTOM_KEY: S['config env_key -> env'] } });
await run({ label: 'X4 auth.json + 进程 env OPENAI_API_KEY 同时在 —— 谁赢', authJson: true, processEnv: { OPENAI_API_KEY: S['env OPENAI_API_KEY'] } });
await run({ label: 'X5 config 有 env_key 但那个变量没设 —— 会回落到 auth.json 吗', authJson: true, envKeyInConfig: 'PROBE_CUSTOM_KEY' });

await run({ label: 'X6 requires_openai_auth = true + 只有 auth.json 的 OPENAI_API_KEY', authJson: true, requiresOpenaiAuth: true });
await run({ label: 'X7 requires_openai_auth = true + 只有进程 env OPENAI_API_KEY', requiresOpenaiAuth: true, processEnv: { OPENAI_API_KEY: S['env OPENAI_API_KEY'] } });
await run({ label: 'X8 requires_openai_auth = true + 什么都没有 —— 失败形状', requiresOpenaiAuth: true });
await run({ label: 'X9 requires_openai_auth = true + auth.json 是 ChatGPT 登录形状(tokens)', chatgptAuthJson: true, requiresOpenaiAuth: true });

await run({ label: 'X10 内置 openai provider(改写 base_url)+ auth.json 的 OPENAI_API_KEY', builtinOpenai: true, requiresOpenaiAuth: true, authJson: true });
await run({ label: 'X11 内置 openai provider + 只有进程 env OPENAI_API_KEY', builtinOpenai: true, requiresOpenaiAuth: true, processEnv: { OPENAI_API_KEY: S['env OPENAI_API_KEY'] } });
await run({ label: 'X12 内置 openai provider + 什么都没有 —— 失败形状', builtinOpenai: true, requiresOpenaiAuth: true });

await run({ label: 'X13 凭据缺失 + 网关回 401 —— 用户实际会看到的失败形状', requiresOpenaiAuth: true, gatewayStatus: 401 });
