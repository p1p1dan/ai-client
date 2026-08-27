// C 组 —— 决定性对照：那条 allow 规则本身到底有没有效？
// 手法：拿掉 canUseTool。若 allow 有效，工具应当自动放行并真的执行（哨兵文件消失）；
// 若无效，非交互模式下无人批准，工具应当被拒。
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMockApi } from './mockapi.mjs';
const TOOL_INPUT = { command: 'curl --version | head -1' };
const REPO='/home/ai/code/ai-client';
const { query } = await import(`${REPO}/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const CLI=`${REPO}/src/agent-host/node_modules/@cometix/claude-code/cli.js`;
const ROOT=process.env.PROBE_ROOT;

async function run({ label, projectAllow, withCanUseTool }) {
  const HOME=join(ROOT,'c-home'), PROJ=join(ROOT,'c-proj');
  rmSync(HOME,{recursive:true,force:true}); rmSync(PROJ,{recursive:true,force:true});
  mkdirSync(join(HOME,'.claude'),{recursive:true}); mkdirSync(join(PROJ,'.claude'),{recursive:true});
  writeFileSync(join(HOME,'.claude.json'), JSON.stringify({hasCompletedOnboarding:true,
    projects:{[PROJ]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}}));
  writeFileSync(join(PROJ,'.claude','settings.json'), JSON.stringify(
    projectAllow ? { permissions: { allow: [projectAllow] } } : {}, null, 2));
  const SENTINEL = join(PROJ,'probe-target.txt');
  writeFileSync(SENTINEL, 'delete me\n');

  const api = await startMockApi({ toolInput: TOOL_INPUT });
  const env={...process.env, HOME, USERPROFILE:HOME,
    ANTHROPIC_BASE_URL:api.baseUrl, ANTHROPIC_AUTH_TOKEN:'probe-token',
    // 生产也设这个；不设的话第一发请求会被一个后台调用吃掉，真回合落到第二发。
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete env.CLAUDE_CONFIG_DIR; delete env.ANTHROPIC_API_KEY;
  const calls=[]; const results=[];
  const abort=new AbortController(); const t=setTimeout(()=>abort.abort(),60000);
  try {
    const stream = query({ prompt:'Delete the probe target.', options:{
      cwd: PROJ, pathToClaudeCodeExecutable: CLI, executable: process.execPath,
      tools:{type:'preset',preset:'claude_code'}, settingSources:['project'],
      permissionMode:'default',
      ...(withCanUseTool ? { canUseTool: async (n,i)=>{ calls.push(n); return {behavior:'allow', updatedInput:i}; } } : {}),
      env, abortController: abort } });
    for await (const m of stream) {
      results.push('MSG:'+m.type+(m.type==='assistant'?'/'+(m.message?.content?.[0]?.type??'?'):''));
      if (m.type==='result') results.push(`result:${m.subtype} err=${m.is_error} api=${m.api_error_status ?? '-'}`);
      if (m.type==='system' && m.subtype!=='init') results.push('system:'+m.subtype);
      if (m.type==='user') {
        const c = m.message?.content?.[0];
        if (c?.type==='tool_result') results.push(String(c.content).slice(0,90));
      }
    }
  } catch(e){ results.push('THROWN: '+String(e.message).slice(0,90)); }
  finally { clearTimeout(t); api.close(); }
  console.log('====', label);
  console.log('   canUseTool 调用:', calls.length);
  const ran = results.some((r) => r.includes('curl '));
  console.log('   工具真的执行了吗:', ran);
  console.log('   messages       :', results.join(' | ').slice(0,220) || '(无)');
  console.log('   api 调用次数   :', api.requests.length);
}

await run({ label:'C1 有 allow + 无 canUseTool  → allow 若有效，应自动放行', projectAllow:'Bash(curl:*)', withCanUseTool:false });
await run({ label:'C2 无 allow + 无 canUseTool  → 对照，应被拒',            projectAllow:null,          withCanUseTool:false });
await run({ label:'C3 有 allow + 有 canUseTool  → canUseTool 会不会被跳过', projectAllow:'Bash(curl:*)', withCanUseTool:true });
