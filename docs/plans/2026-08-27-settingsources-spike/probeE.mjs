// E 组 —— ask:['*'] 会不会让今天自动放行的工具也开始弹卡？
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;

async function run({ label, settingSources, managedSettings, toolInput }) {
  const HOME=join(ROOT,'e-home'), PROJ=join(ROOT,'e-proj');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'.claude','settings.json'), JSON.stringify({}, null, 2));
  const api = await startMockApi({ toolInput });
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
      if (c?.type==='tool_result') out.push(String(c.content).slice(0,60)); } }
  } catch(e){ out.push('THROWN'); } finally { clearTimeout(t); api.close(); }
  console.log(`${String(calls.length).padStart(2)} 次 canUseTool | ${label}`);
}

const ECHO={command:'echo HELLO'};
const CURL={command:'curl --version | head -1'};
console.log('--- 今天的生产配置 settingSources:[] ---');
await run({label:'echo（本来就安全的命令）', settingSources:[], toolInput:ECHO});
await run({label:'curl（需要审批的命令）',   settingSources:[], toolInput:CURL});
console.log("--- 候选方案 settingSources:['user','project'] + managedSettings ask:['*'] ---");
await run({label:'echo（本来就安全的命令）', settingSources:['user','project'], managedSettings:{permissions:{ask:['*']}}, toolInput:ECHO});
await run({label:'curl（需要审批的命令）',   settingSources:['user','project'], managedSettings:{permissions:{ask:['*']}}, toolInput:CURL});
