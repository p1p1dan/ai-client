// L 组 —— settings.local.json 这一层的独立行为（前面几轮只测过「三个一起开」的合并结果）
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const SDK=`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`;
const { query, resolveSettings } = await import(SDK);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;
const HOME=join(ROOT,'l-home'), PROJ=join(ROOT,'l-proj');

function fixture() {
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  // 只有本机级这一份有内容；用户级与项目级刻意留空，好让效果只可能来自它
  writeFileSync(join(HOME,'.claude','settings.json'), '{}');
  writeFileSync(join(PROJ,'.claude','settings.json'), '{}');
  writeFileSync(join(PROJ,'.claude','settings.local.json'), JSON.stringify({
    permissions: { allow: ['Bash(curl:*)'] },
    env: { PROBE_LOCAL_ENV_SENTINEL: 'from-local-file' },
    model: 'local-picked-model',
  }, null, 2));
}

// —— 第一部分：层叠（零 spawn）——
fixture();
process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.CLAUDE_CONFIG_DIR;
for (const [label, sources] of [
  ["现在的形态 ['user','project']", ['user','project']],
  ["加上之后 ['user','project','local']", ['user','project','local']],
  ["只开 local（看它单独载入什么）", ['local']],
]) {
  const r = await resolveSettings({ cwd: PROJ, settingSources: sources });
  const eff = r.effective ?? {};
  console.log(`${label}`);
  console.log(`   载入的层: ${r.sources.map(x=>x.source).join(', ') || '(无)'}`);
  console.log(`   免问清单: ${JSON.stringify(eff.permissions?.allow ?? null)} | env 键: ${Object.keys(eff.env??{}).join(',')||'(无)'} | model: ${eff.model ?? '(无)'}`);
}

// —— 第二部分：真跑一回合，看那条免问规则到底认不认 ——
async function realRun(sources) {
  fixture();
  const api = await startMockApi({ toolName:'Bash', toolInput:{command:'curl --version'} });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  let cards=0;
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),50000);
  try {
    const stream = query({ prompt:'Do it.', options:{ cwd:PROJ,
      pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'}, settingSources:sources, permissionMode:'default',
      canUseTool: async (_n,_i)=>{ cards+=1; return {behavior:'deny',message:'probe'}; },
      env, abortController: abort } });
    for await (const _m of stream) {}
  } catch(e){} finally { clearTimeout(t); api.close(); }
  return cards;
}
console.log('\n真跑一回合（免问规则只写在 settings.local.json 里）：');
console.log(`   ['user','project']          → ${await realRun(['user','project'])} 张权限卡（应 1 = 没读到那条规则）`);
console.log(`   ['user','project','local']  → ${await realRun(['user','project','local'])} 张权限卡（应 0 = 读到并照办了）`);
