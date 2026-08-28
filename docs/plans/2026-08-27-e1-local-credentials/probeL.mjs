// L 组 —— Claude 侧:不注入任何东西时,随包 CLI 自己能从哪里拿到凭据,以及谁赢。
//
// 手法:每个凭据来源在夹具里写一个互不相同的哨兵值,base_url 统一指向本机假端点。
// 于是"这一发请求带着谁的凭据"直接从请求头里读出来;一发都没有 = 这一路不成立。
// base_url 每臂都设,是为了让各臂可比 —— 它本身不提供凭据,L0 就是那条对照。
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi, labelOf } from './mockapi.mjs';

const REPO = '/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI = `${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT = process.env.PROBE_ROOT;
const TRACE_CAP = Number(process.env.PROBE_TRACE_CAP ?? 460);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);

const S = {
  'credentials.json (OAuth)': 'SENTINEL-OAUTH-CREDENTIALS-JSON',
  'user settings.json env': 'SENTINEL-USER-SETTINGS-ENV',
  'project settings.json env': 'SENTINEL-PROJECT-SETTINGS-ENV',
  'process env': 'SENTINEL-PROCESS-ENV',
  'apiKeyHelper': 'SENTINEL-API-KEY-HELPER',
};

const HOUR = 3600_000;

function fixture({ credentialsJson, credentialsExpired, credentialsCorrupt, userSettings, projectSettings, helper }) {
  const HOME = join(ROOT, 'l-home');
  const PROJ = join(ROOT, 'l-proj');
  rmSync(HOME, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  mkdirSync(join(PROJ, '.claude'), { recursive: true });
  // 不写这两键 CLI 会停在 onboarding / trust 对话上,整组就没法比。
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [PROJ]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  if (credentialsCorrupt) {
    writeFileSync(join(HOME, '.claude', '.credentials.json'), '{ this is not json', { mode: 0o600 });
  }
  if (credentialsJson || credentialsExpired) {
    writeFileSync(join(HOME, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: S['credentials.json (OAuth)'],
        refreshToken: `${S['credentials.json (OAuth)']}-REFRESH`,
        expiresAt: credentialsExpired ? Date.now() - 24 * HOUR : Date.now() + 24 * HOUR,
        refreshTokenExpiresAt: credentialsExpired ? Date.now() - HOUR : Date.now() + 30 * 24 * HOUR,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }), { mode: 0o600 });
  }
  let helperPath = null;
  if (helper) {
    helperPath = join(HOME, 'key-helper.sh');
    writeFileSync(helperPath, `#!/bin/sh\nprintf '%s' '${S.apiKeyHelper}'\n`, { mode: 0o755 });
    chmodSync(helperPath, 0o755);
  }
  if (userSettings || helper) {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({
      ...(userSettings ? { env: { ANTHROPIC_AUTH_TOKEN: S['user settings.json env'] } } : {}),
      ...(helper ? { apiKeyHelper: helperPath } : {}),
    }, null, 2));
  }
  if (projectSettings) {
    writeFileSync(join(PROJ, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: S['project settings.json env'] },
    }, null, 2));
  }
  return { HOME, PROJ };
}

async function runAll({ label, processEnvKey, gatewayStatus = 200, ...spec }) {
  const { HOME, PROJ } = fixture(spec);
  const api = await startMockApi({ status: gatewayStatus });
  const env = {
    ...process.env,
    HOME, USERPROFILE: HOME,
    ANTHROPIC_BASE_URL: api.baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (processEnvKey) env.ANTHROPIC_API_KEY = S['process env'];

  const seen = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const stream = query({
      prompt: 'Say PROBE and stop.',
      options: {
        cwd: PROJ,
        pathToClaudeCodeExecutable: CLI,
        executable: process.execPath,
        tools: { type: 'preset', preset: 'claude_code' },
        // 生产同款三层
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'default',
        env,
        abortController: abort,
        stderr: (line) => { if (seen.length < 60) seen.push(`stderr: ${line.slice(0, 160)}`); },
      },
    });
    for await (const m of stream) {
      if (m.type === 'result') {
        seen.push(`result:${m.subtype} err=${m.is_error} api=${m.api_error_status ?? '-'}`);
        if (m.is_error && typeof m.result === 'string') seen.push(`result.text: ${m.result.slice(0, 200)}`);
      }
    }
  } catch (e) {
    seen.push(`THROWN: ${String(e.message).slice(0, 240)}`);
  } finally {
    clearTimeout(timer);
    api.close();
  }

  const req = api.requests[0];
  console.log('====', label);
  console.log('   请求发出去了吗 :', api.requests.length > 0 ? `是 (${api.requests.length} 发)` : '否');
  if (req) {
    console.log('   authorization  :', labelOf(req.authorization, S));
    console.log('   x-api-key      :', labelOf(req.xApiKey, S));
  }
  console.log('   痕迹           :', seen.join(' | ').slice(0, TRACE_CAP) || '(无)');
}

const ONLY = process.env.PROBE_ONLY;
async function run(spec) {
  if (ONLY && !spec.label.startsWith(ONLY)) return;
  return runAll(spec);
}

await run({ label: 'L0 空 home,只有 base_url —— 对照:base_url 本身不是凭据' });
await run({ label: 'L1 只有 ~/.claude/.credentials.json(订阅 OAuth)', credentialsJson: true });
await run({ label: 'L2 只有 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN', userSettings: true });
await run({ label: 'L3 只有进程环境变量 ANTHROPIC_API_KEY', processEnvKey: true });
await run({ label: 'L4 只有 apiKeyHelper(settings.json 指向一个脚本)', helper: true });
await run({ label: 'L5 只有项目级 .claude/settings.json 的 env', projectSettings: true });
await run({ label: 'L6 OAuth + 用户 settings env 同时在 —— 谁赢', credentialsJson: true, userSettings: true });
await run({ label: 'L7 用户 settings env + 进程 env 同时在 —— 谁赢', userSettings: true, processEnvKey: true });
await run({ label: 'L8 .credentials.json 在,但 OAuth 已过期(连 refresh 也过期)', credentialsExpired: true });
await run({ label: 'L9 .credentials.json 在,但内容不是合法 JSON', credentialsCorrupt: true });

await run({ label: 'L10 凭据在但被网关拒绝(401)—— 用户实际会看到的失败形状', userSettings: true, gatewayStatus: 401 });
