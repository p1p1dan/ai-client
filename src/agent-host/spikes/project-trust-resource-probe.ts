/**
 * Probe — does `projectTrusted: false` (what managed mode sends) also hide the
 * repo's skills and prompt templates, or only its settings.json?
 *
 * Settings are already answered by source: `SettingsManager.loadFromStorage`
 * returns `{}` for scope "project" when untrusted. Skills and prompts are
 * loaded by DefaultResourceLoader from `<cwd>/.pi/{skills,prompts}` on a
 * separate path, so the answer for them has to be measured.
 *
 * Isolated cwd AND agentDir: must never read the developer's own ~/.pi.
 *
 *   node --experimental-strip-types src/agent-host/spikes/project-trust-resource-probe.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBorrowedResourcePaths } from '../userResourcePaths.ts';

type Skill = { name?: string; path?: string; filePath?: string; sourceInfo?: { path?: string } };
type Prompt = { name?: string; path?: string; sourceInfo?: { path?: string } };
type Loader = {
  getSkills?: () => { skills?: Skill[] };
  getPrompts?: () => { prompts?: Prompt[] };
};

const cwd = mkdtempSync(join(tmpdir(), 'pi-trust-probe-cwd-'));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-trust-probe-agent-'));
/** Stands in for the user's own ~/.pi/agent, which managed mode does not read. */
const userPiDir = mkdtempSync(join(tmpdir(), 'pi-trust-probe-userpi-'));

function seed(): void {
  // Global (agentDir) resources — the control group. These must survive both runs.
  mkdirSync(join(agentDir, 'skills', 'global-skill'), { recursive: true });
  writeFileSync(
    join(agentDir, 'skills', 'global-skill', 'SKILL.md'),
    '---\nname: global-skill\ndescription: from agentDir\n---\n\nglobal body\n'
  );
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', 'global-prompt.md'), 'global prompt body\n');
  // No `packages` in either settings file: a trusted run resolves them for real
  // (npm install into <cwd>/.pi/npm), which both fails offline and is itself the
  // supply-chain reason managed mode sends projectTrusted: false. Settings scope
  // is already answered by source — SettingsManager.loadFromStorage returns {}
  // for scope "project" when untrusted. This probe measures skills and prompts.
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));

  // Project (.pi under cwd) resources — the variable under test.
  mkdirSync(join(cwd, '.pi', 'skills', 'project-skill'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'skills', 'project-skill', 'SKILL.md'),
    '---\nname: project-skill\ndescription: from repo\n---\n\nproject body\n'
  );
  mkdirSync(join(cwd, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'prompts', 'project-prompt.md'), 'project prompt body\n');
  // A project-scoped setting with a visible effect but no install side-effect,
  // so the settings half of the answer is still observable in the output.
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

  // The user's own ~/.pi/agent — where docs and models tell people to install.
  mkdirSync(join(userPiDir, 'skills', 'userpi-skill'), { recursive: true });
  writeFileSync(
    join(userPiDir, 'skills', 'userpi-skill', 'SKILL.md'),
    '---\nname: userpi-skill\ndescription: installed the documented way\n---\n\nbody\n'
  );
  mkdirSync(join(userPiDir, 'prompts'), { recursive: true });
  writeFileSync(join(userPiDir, 'prompts', 'userpi-prompt.md'), 'user pi prompt body\n');
}

async function run(projectTrusted: boolean, borrowUserPi = false): Promise<void> {
  const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
    SettingsManager: {
      create: (
        cwd: string,
        agentDir: string,
        o: { projectTrusted: boolean }
      ) => {
        getGlobalSettings?: () => Record<string, unknown>;
        getProjectSettings?: () => Record<string, unknown>;
      };
    };
    createAgentSessionServices: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
  // R01 end-to-end: the paths come from the shipping module, not from literals,
  // so this run proves what OUR code produces is what the real SDK accepts.
  // Note it hands over resources only — never additionalExtensionPaths.
  const paths = borrowUserPi
    ? resolveBorrowedResourcePaths(userPiDir, agentDir)
    : { skills: [], promptTemplates: [] };
  const borrowed = {
    ...(paths.skills.length > 0 ? { additionalSkillPaths: paths.skills } : {}),
    ...(paths.promptTemplates.length > 0
      ? { additionalPromptTemplatePaths: paths.promptTemplates }
      : {}),
  };
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: borrowed,
  });
  const loader = services.resourceLoader as Loader | undefined;

  const where = (r: Skill | Prompt) => r.sourceInfo?.path ?? r.path ?? '?';
  const skills = (loader?.getSkills?.().skills ?? []).map((s) => `${s.name ?? '?'} @ ${where(s)}`);
  const prompts = (loader?.getPrompts?.().prompts ?? []).map(
    (p) => `${p.name ?? '?'} @ ${where(p)}`
  );
  const label = borrowUserPi ? ' + borrowed ~/.pi paths' : '';
  console.log(`\n=== projectTrusted: ${projectTrusted}${label} ===`);
  console.log(`  global settings : ${JSON.stringify(settingsManager.getGlobalSettings?.() ?? {})}`);
  console.log(
    `  project settings: ${JSON.stringify(settingsManager.getProjectSettings?.() ?? {})}`
  );
  console.log(`  skills          : ${JSON.stringify(skills)}`);
  console.log(`  prompts         : ${JSON.stringify(prompts)}`);
}

try {
  seed();
  console.log(`[probe] cwd      = ${cwd}`);
  console.log(`[probe] agentDir = ${agentDir}`);
  await run(true);
  await run(false);
  await run(false, true);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(userPiDir, { recursive: true, force: true });
}
