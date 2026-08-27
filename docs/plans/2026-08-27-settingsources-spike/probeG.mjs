// G 组 —— 「有副作用的」到底该列哪些？先拿到工具全集，再看哪些今天就会弹卡。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;
const HOME=join(ROOT,'g-home'), PROJ=join(ROOT,'g-proj');
rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
  projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
writeFileSync(join(PROJ,'.claude','settings.json'), '{}');
const api = await startMockApi({ toolName:'Bash', toolInput:{command:'echo x'} });
const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
  ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
const abort=new AbortController(); setTimeout(()=>abort.abort(),40000);
const stream = query({ prompt:'hi', options:{ cwd:PROJ, pathToClaudeCodeExecutable:CLI,
  executable:process.execPath, tools:{type:'preset',preset:'claude_code'},
  settingSources:['user','project'], permissionMode:'default',
  canUseTool: async (n,i)=>({behavior:'allow',updatedInput:i}), env, abortController:abort } });
for await (const m of stream) {
  if (m.type==='system' && m.subtype==='init') {
    console.log('工具全集:', JSON.stringify(m.tools));
    break;
  }
}
api.close();
