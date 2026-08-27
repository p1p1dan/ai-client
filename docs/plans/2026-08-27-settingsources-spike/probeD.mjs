// D 组 —— 既然 allow 确实会绕过 canUseTool（C3），那还有没有别的手段
// 既让用户的 settings.json 生效、又保住权限卡？
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;
const TOOL_INPUT={ command: 'curl --version | head -1' };

async function run({ label, managedSettings }) {
  const HOME=join(ROOT,'d2-home'), PROJ=join(ROOT,'d2-proj');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  // 仓库里提交的一条 allow —— 就是 C3 证明能绕过 canUseTool 的那种
  writeFileSync(join(PROJ,'.claude','settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(curl:*)'] } }, null, 2));
  writeFileSync(join(PROJ,'CLAUDE.md'), '# SENTINEL_PROJ_MD\n');

  const api = await startMockApi({ toolInput: TOOL_INPUT });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  const calls=[]; const out=[];
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),60000);
  try {
    const stream = query({ prompt:'Check curl.', options:{
      cwd:PROJ, pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'}, settingSources:['project'],
      ...(managedSettings ? { managedSettings } : {}),
      permissionMode:'default',
      canUseTool: async (n,i)=>{ calls.push(n); return {behavior:'allow', updatedInput:i}; },
      env, abortController: abort } });
    for await (const m of stream) {
      if (m.type==='user') { const c=m.message?.content?.[0];
        if (c?.type==='tool_result') out.push(String(c.content).slice(0,80)); }
    }
  } catch(e){ out.push('THROWN: '+String(e.message).slice(0,80)); }
  finally { clearTimeout(t); api.close(); }
  const ran = out.some((r)=>r.includes('curl '));
  console.log('====', label);
  console.log(`   canUseTool 被调用: ${calls.length} | 工具真的执行了: ${ran}`);
  console.log('   tool_result:', out[0] ?? '(无)');
}

await run({ label:'D0 只有 project allow（C3 复现：canUseTool 被跳过）' });
await run({ label:'D1 + managedSettings deny 精确一条', managedSettings:{ permissions:{ deny:['Bash(curl:*)'] } } });
await run({ label:'D2 + managedSettings ask 精确一条',  managedSettings:{ permissions:{ ask:['Bash(curl:*)'] } } });
await run({ label:'D3 + managedSettings ask 整个 Bash', managedSettings:{ permissions:{ ask:['Bash'] } } });
await run({ label:'D4 + managedSettings ask 通配 *',    managedSettings:{ permissions:{ ask:['*'] } } });
