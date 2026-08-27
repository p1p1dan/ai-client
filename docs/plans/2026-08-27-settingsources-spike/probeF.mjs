// F 组 —— 两件还没量过的事：
//   ① 仓库里提交的 hooks 会不会真的被执行
//   ② 收窄的 ask 名单会放行哪些工具
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;

async function run({ label, settingSources, managedSettings, tool, input, withHook }) {
  const HOME=join(ROOT,'f-home'), PROJ=join(ROOT,'f-proj');
  const HOOK_SENTINEL=join(ROOT,'f-hook-fired.txt');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  rmSync(HOOK_SENTINEL,{force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'.claude','settings.json'), JSON.stringify(
    withHook ? { hooks: { PreToolUse: [{ matcher: '*', hooks: [
      { type: 'command', command: `touch ${HOOK_SENTINEL}` }] }] } } : {}, null, 2));
  writeFileSync(join(PROJ,'readme-target.txt'), 'file contents for the Read probe\n');

  const api = await startMockApi({ toolName: tool, toolInput: input });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  const calls=[]; const out=[];
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),60000);
  try {
    const stream = query({ prompt:'Do it.', options:{
      cwd:PROJ, pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'},
      ...(settingSources===undefined?{}:{settingSources}),
      ...(managedSettings?{managedSettings}:{}),
      permissionMode:'default',
      canUseTool: async (n,i)=>{ calls.push(n); return {behavior:'allow', updatedInput:i}; },
      env, abortController: abort } });
    for await (const m of stream) { if (m.type==='user'){ const c=m.message?.content?.[0];
      if (c?.type==='tool_result') out.push(String(c.content).slice(0,50)); } }
  } catch(e){ out.push('THROWN'); } finally { clearTimeout(t); api.close(); }
  const hookFired = existsSync(HOOK_SENTINEL);
  console.log(`${String(calls.length).padStart(2)} 次权限卡 | hook 被执行: ${String(hookFired).padEnd(5)} | ${label}`);
  return { calls: calls.length, hookFired };
}

const READ={tool:'Read', input:{file_path: join(ROOT,'f-proj','readme-target.txt')}};
const BASH={tool:'Bash', input:{command:'curl --version | head -1'}};

console.log('=== ① 仓库里提交的 hooks 会不会被执行 ===');
await run({label:"今天：settingSources:[]（忽略仓库配置）", settingSources:[], withHook:true, ...BASH});
await run({label:"候选：settingSources:['user','project']", settingSources:['user','project'],
           managedSettings:{permissions:{ask:['*']}}, withHook:true, ...BASH});

console.log('\n=== ② 收窄的 ask 名单会放行哪些工具 ===');
await run({label:"读文件 · 今天 settingSources:[]",            settingSources:[], ...READ});
await run({label:"读文件 · ask:['*'] 全部都问",                settingSources:['user','project'], managedSettings:{permissions:{ask:['*']}}, ...READ});
await run({label:"读文件 · ask:['Bash','Write','Edit'] 只问有副作用的", settingSources:['user','project'], managedSettings:{permissions:{ask:['Bash','Write','Edit']}}, ...READ});
await run({label:"跑命令 · ask:['Bash','Write','Edit'] 只问有副作用的", settingSources:['user','project'], managedSettings:{permissions:{ask:['Bash','Write','Edit']}}, ...BASH});
