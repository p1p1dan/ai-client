import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sdkRoot = join(repo, 'src/agent-host/node_modules/@earendil-works/pi-coding-agent');
const name = 'b1a-shared-skill-probe';

if (process.argv[2] === '--child') {
  const { createAgentSessionServices, SettingsManager } = await import(
    pathToFileURL(join(sdkRoot, 'dist/index.js')).href
  );
  const mode = process.argv[3];
  const cwd = join(process.env.HOME, 'workspace');
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, '.pi/agent');
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: mode === 'local' }),
  });
  const skill = services.resourceLoader.getSkills().skills.find((item) => item.name === name);
  process.stdout.write(
    `${JSON.stringify({ mode, loaded: !!skill, sourceInfo: skill?.sourceInfo ?? null })}\n`,
    () => {
      if (process.parentPort) process.exit(0);
    }
  );
} else {
  // An isolated HOME exercises real home discovery without reading credentials,
  // running user extensions, or leaving a probe skill in the user's directories.
  const home = mkdtempSync(join(tmpdir(), 'aiclient-b1a-'));
  try {
    const skillDir = join(home, '.agents/skills', name);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(home, 'workspace'));
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Shared skill discovery probe.\n---\nProbe only.\n`
    );
    const reports = ['managed', 'local', 'tui-loader'].map((mode) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.PI_CODING_AGENT_DIR;
      if (mode !== 'local') env.PI_CODING_AGENT_DIR = join(home, '.pilab/probe/pi-agent');
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout.trim().split('\n').at(-1));
    });
    const version = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)('electron');
    const parent = join(home, 'utility-probe.cjs');
    writeFileSync(
      parent,
      `
const { app, utilityProcess } = require('electron');
app.whenReady().then(async () => {
  for (const mode of ['managed', 'local']) {
    const env = { ...process.env };
    delete env.PI_CODING_AGENT_DIR;
    if (mode === 'managed') env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(home, '.pilab/probe/pi-agent'))};
    await new Promise((resolve, reject) => {
      const worker = utilityProcess.fork(${JSON.stringify(fileURLToPath(import.meta.url))}, ['--child', mode], { env, stdio: 'pipe' });
      let output = '';
      let errors = '';
      worker.stdout.on('data', chunk => output += chunk);
      worker.stderr.on('data', chunk => errors += chunk);
      const timeout = setTimeout(() => { worker.kill(); reject(new Error('utility probe timed out')); }, 30000);
      worker.on('exit', code => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error(errors));
        const report = JSON.parse(output.trim().split('\\n').at(-1));
        console.log(JSON.stringify({ ...report, transport: 'utilityProcess' }));
        resolve();
      });
    });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`
    );
    const utility = spawnSync(
      electron,
      [
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${join(home, 'electron-profile')}`,
        parent,
      ],
      { env, encoding: 'utf8', timeout: 65_000 }
    );
    assert.equal(utility.status, 0, utility.stderr);
    const utilityReports = utility.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert.equal(utilityReports.length, 2);

    const extension = join(home, 'tui-probe.mjs');
    const tuiReport = join(home, 'tui-report.json');
    writeFileSync(
      extension,
      `
import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(${JSON.stringify(tuiReport)}, JSON.stringify({ tty: !!process.stdin.isTTY, commands: pi.getCommands() }));
    ctx.shutdown();
  });
}
`
    );
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    // The launch plan's packaged route uses an absolute Node executable and
    // bundled CLI. script supplies a real PTY without requiring a model call.
    const command = [
      process.execPath,
      join(sdkRoot, 'dist/bundle/cli.js'),
      '--no-session',
      '-e',
      extension,
    ]
      .map(shellQuote)
      .join(' ');
    const tui = spawnSync('script', ['-q', '-e', '-c', command, '/dev/null'], {
      cwd: join(home, 'workspace'),
      env: {
        ...env,
        PI_CODING_AGENT_DIR: join(home, '.pilab/probe/pi-agent'),
        TERM: 'xterm-256color',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(tui.status, 0, tui.stderr || tui.stdout.slice(-2000));
    const cli = JSON.parse(readFileSync(tuiReport, 'utf8'));
    const tuiPtyVerified =
      cli.tty && cli.commands.some((command) => command.name === `skill:${name}`);
    const ok =
      [...reports, ...utilityReports].every(
        (report) => report.loaded && report.sourceInfo?.scope === 'user'
      ) && tuiPtyVerified;
    console.log(JSON.stringify({ ok, version, reports, utilityReports, tuiPtyVerified }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
