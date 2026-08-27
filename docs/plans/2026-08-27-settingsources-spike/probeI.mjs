// I 组 —— 今天（settingSources:[]）到底哪些工具会弹卡、哪些自动放行？
// 名单要精确等于「今天会弹卡的那些」，才叫保持今天手感。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;
const HOME=join(ROOT,'i-home'), PROJ=join(ROOT,'i-proj');

async function probe(tool, input) {
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'probe.txt'),'hello\n');
  const api = await startMockApi({ toolName: tool, toolInput: input });
  const env={...process.env, HOME, USERPROFILE:HOME, ANTHROPIC_BASE_URL:api.baseUrl,
    ANTHROPIC_AUTH_TOKEN:'probe-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  const calls=[]; const results=[];
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),40000);
  try {
    const stream = query({ prompt:'Do it.', options:{ cwd:PROJ,
      pathToClaudeCodeExecutable:CLI, executable:process.execPath,
      tools:{type:'preset',preset:'claude_code'}, settingSources:[], permissionMode:'default',
      canUseTool: async (n,i)=>{ calls.push(n); return {behavior:'allow', updatedInput:i}; },
      env, abortController: abort } });
    for await (const _m of stream) {}
  } catch(e){} finally { clearTimeout(t); api.close(); }
  return { n: calls.length, r: results[0] ?? '(无结果)' };
}

const CASES = [
  ['Read',        { file_path: join(PROJ,'probe.txt') }],
  ['Glob',        { pattern: '*.txt' }],
  ['Grep',        { pattern: 'hello' }],
  ['WebSearch',   { query: 'anything' }],
  ['WebFetch',    { url: 'https://example.com', prompt: 'x' }],
  ['Write',       { file_path: join(PROJ,'new.txt'), content: 'x' }],
  ['Edit',        { file_path: join(PROJ,'probe.txt'), old_string: 'hello', new_string: 'bye' }],
  ['Bash',        { command: 'curl --version' }],
  ['NotebookEdit',{ notebook_path: join(PROJ,'n.ipynb'), new_source: 'x', edit_mode: 'insert' }],
  ['Task',        { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }],
];
const asks=[], autos=[];
for (const [tool, input] of CASES) {
  const { n, r } = await probe(tool, input);
  (n > 0 ? asks : autos).push(tool);
  console.log(`${n>0?'弹卡  ':'自动放行'} | ${tool.padEnd(13)} | 工具结果: ${r}`);
}
console.log('\n今天会弹卡的:', JSON.stringify(asks));
console.log('今天自动放行的:', JSON.stringify(autos));
