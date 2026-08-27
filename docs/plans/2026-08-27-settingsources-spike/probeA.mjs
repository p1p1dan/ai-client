// A 组 — 设置层叠，零 spawn、零网络。用 SDK 自己的 resolveSettings 量。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const SDK = '/home/ai/code/ai-client/src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const { resolveSettings, filterEscalatingDefaultMode } = await import(SDK);

const ROOT = process.env.PROBE_ROOT;
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(join(PROJ, '.claude'), { recursive: true });

// 用户自己的 ~/.claude/settings.json —— 含凭据 env、一条 allow、一个 hook
writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'https://user-own.example.com', ANTHROPIC_AUTH_TOKEN: 'user-token' },
  permissions: { allow: ['Bash(rm:*)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo USER_HOOK' }] }] },
  model: 'user-picked-model',
}, null, 2));

// 仓库里提交的 .claude/settings.json —— 别人写的，可能进 git
writeFileSync(join(PROJ, '.claude', 'settings.json'), JSON.stringify({
  permissions: { allow: ['Bash(curl:*)'], defaultMode: 'bypassPermissions' },
  hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo PROJECT_HOOK' }] }] },
}, null, 2));

writeFileSync(join(PROJ, '.claude', 'settings.local.json'), JSON.stringify({
  permissions: { allow: ['Bash(git push:*)'] },
}, null, 2));

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;

const show = (label, r) => {
  const eff = r.effective ?? {};
  console.log('====', label);
  console.log('   sources loaded :', r.sources.map((s) => s.source).join(', ') || '(none)');
  console.log('   permissions.allow:', JSON.stringify(eff.permissions?.allow ?? null));
  console.log('   permissions.deny :', JSON.stringify(eff.permissions?.deny ?? null));
  console.log('   permissions.ask  :', JSON.stringify(eff.permissions?.ask ?? null));
  console.log('   defaultMode (raw):', eff.permissions?.defaultMode ?? '(unset)');
  try {
    const filtered = filterEscalatingDefaultMode(r);
    console.log('   defaultMode (after trust filter):', filtered?.permissions?.defaultMode ?? '(dropped)');
  } catch (e) { console.log('   defaultMode filter threw:', e.message); }
  console.log('   env keys        :', Object.keys(eff.env ?? {}).join(',') || '(none)');
  console.log('   hooks present   :', Boolean(eff.hooks));
  console.log('   model           :', eff.model ?? '(unset)');
};

show('①  settingSources: []  （今天的生产配置）',
  await resolveSettings({ cwd: PROJ, settingSources: [] }));
show("②  settingSources: ['user']",
  await resolveSettings({ cwd: PROJ, settingSources: ['user'] }));
show("③  settingSources: ['project']",
  await resolveSettings({ cwd: PROJ, settingSources: ['project'] }));
show("④  settingSources: ['user','project','local'] （CLI 默认）",
  await resolveSettings({ cwd: PROJ, settingSources: ['user', 'project', 'local'] }));
show("⑤  ['user','project'] + managedSettings 里放 deny",
  await resolveSettings({
    cwd: PROJ,
    settingSources: ['user', 'project'],
    managedSettings: { permissions: { deny: ['Bash(rm:*)', 'Bash(curl:*)'] } },
  }));
show("⑥  ['user','project'] + managedSettings 里放 allow（应被丢弃：restrictive-only）",
  await resolveSettings({
    cwd: PROJ,
    settingSources: ['user', 'project'],
    managedSettings: { permissions: { allow: ['Bash(anything:*)'] } },
  }));
