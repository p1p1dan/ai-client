// H 组 —— 名单开窄了会不会漏？拿 WebFetch（会把数据发出去）试。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;

async function run({ label, projectAllow, ask, tool, input }) {
  const HOME=join(ROOT,'h-home'), PROJ=join(ROOT,'h-proj');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'.claude','settings.json'), JSON.stringify(
    projectAllow ? { permissions:{ allow:[projectAllow] } } : {}, null, 2));
  const api = await startMockApi({ toolName: tool, toolInput: input });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  const calls=[];
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),50000);
  try {
    const stream = query({ prompt:'Do it.', options:{ cwd:PROJ,
      pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'}, settingSources:['user','project'],
      ...(ask?{managedSettings:{permissions:{ask}}}:{}), permissionMode:'default',
      canUseTool: async (n,i)=>{ calls.push(n); return {behavior:'deny', message:'probe deny'}; },
      env, abortController: abort } });
    for await (const _m of stream) {}
  } catch(e){} finally { clearTimeout(t); api.close(); }
  console.log(`${String(calls.length).padStart(2)} 次权限卡 | ${label}`);
}

const WEB={tool:'WebFetch', input:{url:'https://example.com', prompt:'summarize'}};
await run({label:'WebFetch · 没有免问规则 · ask 名单只含 Bash/Write/Edit', ask:['Bash','Write','Edit'], ...WEB});
await run({label:'WebFetch · 有免问规则 WebFetch(*) · ask 名单只含 Bash/Write/Edit（会漏吗）',
           projectAllow:'WebFetch', ask:['Bash','Write','Edit'], ...WEB});
await run({label:'WebFetch · 有免问规则 · ask 名单里加上 WebFetch',
           projectAllow:'WebFetch', ask:['Bash','Write','Edit','WebFetch'], ...WEB});
