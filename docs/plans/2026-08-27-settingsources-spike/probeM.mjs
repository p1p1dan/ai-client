// M 组 —— 拿本仓真实的 .claude/settings.local.json 验一次（它写的是 outputStyle: Concise）
const SDK='/home/ai/code/ai-client/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const { resolveSettings } = await import(SDK);
const REPO='/home/ai/code/ai-client';
for (const [label, sources] of [
  ["改之前 ['user','project']", ['user','project']],
  ["改之后 ['user','project','local']", ['user','project','local']],
]) {
  const r = await resolveSettings({ cwd: REPO, settingSources: sources });
  const eff = r.effective ?? {};
  console.log(`${label}`);
  console.log(`   载入的层  : ${r.sources.map(x=>x.source).join(', ') || '(无)'}`);
  console.log(`   outputStyle: ${eff.outputStyle ?? '(读不到)'}`);
}
