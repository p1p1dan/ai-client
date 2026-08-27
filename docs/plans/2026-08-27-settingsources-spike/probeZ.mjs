// Z 组 —— 按最终形态端到端复核（settingSources:['user','project'] + ask:['*'] + 我们自己放行只读工具）
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;
const READ_ONLY = new Set(['Read','Glob','Grep']);   // 与 claudeRuntime.ts 的 READ_ONLY_TOOLS 一致
const U='SENTINEL_USER_MD_a1', P='SENTINEL_PROJ_MD_b2';

async function run({ label, tool, input, projectAllow }) {
  const HOME=join(ROOT,'z-home'), PROJ=join(ROOT,'z-proj');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude','CLAUDE.md'), `# ${U}\n`);
  writeFileSync(join(PROJ,'CLAUDE.md'), `# ${P}\n`);
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'.claude','settings.json'), JSON.stringify(
    projectAllow?{permissions:{allow:[projectAllow]}}:{}, null, 2));
  writeFileSync(join(PROJ,'probe.txt'),'hello\n');
  const api = await startMockApi({ toolName:tool, toolInput:input });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  let cards=0;
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),50000);
  try {
    const stream = query({ prompt:'Do it.', options:{ cwd:PROJ,
      pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'},
      settingSources:['user','project'],   // 最终形态：不加任何覆盖
      permissionMode:'default',
      canUseTool: async (_n,_i)=>{ cards += 1; return { behavior:'deny', message:'probe' }; },
      env, abortController: abort } });
    for await (const _m of stream) {}
  } catch(e){} finally { clearTimeout(t); api.close(); }
  const bodies = api.requests.map(r=>r.body).join('\n');
  console.log(`${cards} 张权限卡 | 用户CLAUDE.md:${bodies.includes(U)} 项目CLAUDE.md:${bodies.includes(P)} | ${label}`);
}

await run({label:'读文件（应 0 张卡，且两份 CLAUDE.md 都在）', tool:'Read', input:{file_path:join(ROOT,'z-proj','probe.txt')}});
await run({label:'跑命令（应 1 张卡）', tool:'Bash', input:{command:'curl --version'}});
await run({label:'跑命令 + 配置里写了免问规则（0 张卡 = 已接受的代价）', tool:'Bash', input:{command:'curl --version'}, projectAllow:'Bash(curl:*)'});
await run({label:'访问网页 + 配置里写了免问规则（0 张卡 = 已接受的代价）', tool:'WebFetch', input:{url:'https://example.com',prompt:'x'}, projectAllow:'WebFetch'});
